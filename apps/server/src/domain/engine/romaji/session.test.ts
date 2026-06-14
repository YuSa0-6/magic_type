import { describe, it, expect } from 'vitest';
import { TypingSession } from './session';

/** 文字列を1キーずつ流し込み、最後のキーの結果を返す */
function typeAll(session: TypingSession, keys: string): string {
  let last = '';
  for (const k of keys) {
    last = session.acceptKey(k);
  }
  return last;
}

describe('基本入力', () => {
  it('単純な読みを打ち切ると completed になる', () => {
    const s = new TypingSession('かみなり');
    expect(typeAll(s, 'kaminar')).toBe('accepted');
    expect(s.acceptKey('i')).toBe('completed');
    expect(s.typedRomaji).toBe('kaminari');
    expect(s.mistypeCount).toBe(0);
  });

  it('完了後の打鍵は状態を変えない', () => {
    const s = new TypingSession('か');
    typeAll(s, 'ka');
    expect(s.acceptKey('a')).toBe('completed');
    expect(s.typedRomaji).toBe('ka');
  });

  it('空の読みはエラー', () => {
    expect(() => new TypingSession('')).toThrow();
  });

  it('変換できないかなはエラー', () => {
    expect(() => new TypingSession('かA')).toThrow();
  });
});

describe('誤入力(ブロック方式)', () => {
  it('無効なキーは受理されず、誤入力としてカウントされる', () => {
    const s = new TypingSession('か');
    expect(s.acceptKey('x')).toBe('mistyped');
    expect(s.mistypeCount).toBe(1);
    expect(s.typedRomaji).toBe('');
    // 正しいキーで再開できる
    expect(s.acceptKey('k')).toBe('accepted');
    expect(s.acceptKey('a')).toBe('completed');
  });

  it('誤入力は複数回カウントされる', () => {
    const s = new TypingSession('か');
    s.acceptKey('z');
    s.acceptKey('z');
    s.acceptKey('k');
    s.acceptKey('z');
    expect(s.mistypeCount).toBe(3);
  });
});

describe('表記ゆれの動的受理', () => {
  it('し は si / shi / ci のどれでも打てる', () => {
    for (const route of ['si', 'shi', 'ci']) {
      const s = new TypingSession('し');
      expect(typeAll(s, route)).toBe('completed');
      expect(s.mistypeCount).toBe(0);
    }
  });

  it('s の後に h と i のどちらも受理される(ルート並行)', () => {
    const s1 = new TypingSession('しろ');
    expect(typeAll(s1, 'shiro')).toBe('completed');
    const s2 = new TypingSession('しろ');
    expect(typeAll(s2, 'siro')).toBe('completed');
  });

  it('じ は zi / ji、ふ は hu / fu で打てる', () => {
    for (const [reading, routes] of [
      ['じ', ['zi', 'ji']],
      ['ふ', ['hu', 'fu']],
    ] as const) {
      for (const route of routes) {
        const s = new TypingSession(reading);
        expect(typeAll(s, route)).toBe('completed');
      }
    }
  });
});

describe('ん の文脈依存判定', () => {
  it('語末の ん は n 1回では完了しない(nn が必要)', () => {
    const s = new TypingSession('ほん');
    // hon までで完了せず、もう1つ n を打って初めて completed になる
    expect(typeAll(s, 'hon')).toBe('accepted');
    expect(s.acceptKey('n')).toBe('completed');
    expect(s.typedRomaji).toBe('honn');
  });

  it('子音の前の ん は単独 n で打てる', () => {
    const s = new TypingSession('かんじ');
    expect(typeAll(s, 'kanzi')).toBe('completed');
    expect(s.mistypeCount).toBe(0);
  });

  it('子音の前の ん を nn でも打てる(曖昧性の自然解決)', () => {
    const s = new TypingSession('かんじ');
    expect(typeAll(s, 'kannji')).toBe('completed');
    expect(s.mistypeCount).toBe(0);
  });

  it('母音の前の ん は単独 n では打てない', () => {
    const s = new TypingSession('ほんあ');
    typeAll(s, 'hon');
    // ここで a を打つと「な」と解釈されかねないため nn が必須
    expect(s.acceptKey('a')).toBe('mistyped');
    expect(s.acceptKey('n')).toBe('accepted');
    expect(s.acceptKey('a')).toBe('completed');
  });

  it('xn でも打てる', () => {
    const s = new TypingSession('ほん');
    expect(typeAll(s, 'hoxn')).toBe('completed');
  });
});

describe('っ(促音)', () => {
  it('子音重ねで打てる', () => {
    const s = new TypingSession('きって');
    expect(typeAll(s, 'kitte')).toBe('completed');
    expect(s.mistypeCount).toBe(0);
  });

  it('xtu / ltu でも打てる', () => {
    for (const route of ['kixtute', 'kiltute']) {
      const s = new TypingSession('きって');
      expect(typeAll(s, route)).toBe('completed');
      expect(s.mistypeCount).toBe(0);
    }
  });

  it('っち は cchi でも打てる', () => {
    const s = new TypingSession('まっちゃ');
    expect(typeAll(s, 'maccha')).toBe('completed');
  });
});

describe('拗音(2かな)と分割打ち', () => {
  it('ちょ は tyo / cho / cyo で打てる', () => {
    for (const route of ['tyo', 'cho', 'cyo']) {
      const s = new TypingSession('ちょ');
      expect(typeAll(s, route)).toBe('completed');
    }
  });

  it('ちょ は ち + ょ に分割して打てる', () => {
    const s = new TypingSession('ちょ');
    expect(typeAll(s, 'tixyo')).toBe('completed');
  });

  it('ふぁ は fa でも hu + xa でも打てる', () => {
    for (const route of ['fa', 'huxa', 'fuxa']) {
      const s = new TypingSession('ふぁ');
      expect(typeAll(s, route)).toBe('completed');
    }
  });
});

describe('長音(ー)', () => {
  it('ハイフンで打てる', () => {
    const s = new TypingSession('ふぁいあー');
    expect(typeAll(s, 'faia-')).toBe('completed');
  });
});

describe('動的ローマ字ガイド', () => {
  it('開始時はデフォルト表記の全文を表示する', () => {
    expect(new TypingSession('きって').remainingGuide).toBe('kitte');
    expect(new TypingSession('かんじ').remainingGuide).toBe('kanzi');
    expect(new TypingSession('ほん').remainingGuide).toBe('honn');
    expect(new TypingSession('ちょ').remainingGuide).toBe('tyo');
  });

  it('打鍵に追従して残りが縮む', () => {
    const s = new TypingSession('かみ');
    s.acceptKey('k');
    expect(s.remainingGuide).toBe('ami');
    s.acceptKey('a');
    expect(s.remainingGuide).toBe('mi');
  });

  it('別ルートに入るとガイドが追従する(し に s→h)', () => {
    const s = new TypingSession('し');
    expect(s.remainingGuide).toBe('si');
    s.acceptKey('s');
    expect(s.remainingGuide).toBe('i');
    s.acceptKey('h'); // shi ルートへ
    expect(s.remainingGuide).toBe('i');
  });

  it('誤入力ではガイドが変わらない', () => {
    const s = new TypingSession('か');
    s.acceptKey('z');
    expect(s.remainingGuide).toBe('ka');
  });

  it('完了後は空文字', () => {
    const s = new TypingSession('か');
    typeAll(s, 'ka');
    expect(s.remainingGuide).toBe('');
  });
});
