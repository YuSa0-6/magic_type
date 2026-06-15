import { describe, it, expect } from 'vitest';
import { MatchEngine } from './match';
import { CARDS, STARTER_DECK } from './cards';
import { TypingSession } from './romaji/session';
import type { Card } from './cards';

/**
 * MatchEngine(対戦エンジン A1)のテスト。
 *
 * 決定論(時刻 atMs・マスター seed の外部注入)を前提に、相互 HP 削り合い・
 * 撃破/時間切れの勝敗判定・引き分け裁定(ADR 0010 #3/#14/#16, 0011 #12/#13)を検証する。
 * 効果(Effect)の適用は A2 のため本テストでは扱わない(activeEffects は常に空を確認)。
 */

/** カードの最短ローマ字路(動的ガイド全文)。打鍵列の生成に使う。 */
const romajiOf = (card: Card): string => new TypingSession(card.reading).remainingGuide;

const byId = (id: string): Card => {
  const c = CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
};

/** 指定カードだけで構成した N 枚デッキ。手札・山札がすべてそのカードになり制御が容易。 */
const monoDeck = (id: string, n = 20): Card[] => Array.from({ length: n }, () => byId(id));

/** 既定の2陣営対戦(両者同一の mono デッキ・指定 seed)。 */
function makeMatch(opts?: {
  deckA?: Card[];
  deckB?: Card[];
  maxHp?: number;
  timeLimitMs?: number;
  masterSeed?: number;
}): MatchEngine {
  return new MatchEngine(
    [
      { id: 'A', deck: opts?.deckA ?? monoDeck('gale') },
      { id: 'B', deck: opts?.deckB ?? monoDeck('gale') },
    ],
    { maxHp: opts?.maxHp, timeLimitMs: opts?.timeLimitMs, masterSeed: opts?.masterSeed }
  );
}

/**
 * 指定陣営が手札 handIndex のカードを 1 枚詠唱して発動する(全打鍵を時刻 atMs)。
 * mono デッキ前提で、handIndex のカードは cardId と一致している必要がある。
 */
function castFull(
  m: MatchEngine,
  playerId: string,
  handIndex: number,
  cardId: string,
  atMs: number
): void {
  m.selectCard(playerId, handIndex, atMs);
  const r = romajiOf(byId(cardId));
  for (const k of r) {
    m.pressKey(playerId, k, atMs);
  }
}

describe('初期状態と視点', () => {
  it('両陣営とも HP80・手札4・山札16・効果なしで始まる(ADR 0010 #10)', () => {
    const m = makeMatch();
    const a = m.snapshot('A');
    expect(a.self.hp).toBe(80);
    expect(a.self.maxHp).toBe(80);
    expect(a.self.hand).toHaveLength(4);
    expect(a.self.drawPileCount).toBe(16);
    expect(a.self.discardPileCount).toBe(0);
    expect(a.self.activeEffects).toEqual([]);
    expect(a.opponent.hp).toBe(80);
    expect(a.outcome).toEqual({ kind: 'ongoing' });
  });

  it('視点を入れ替えると self/opponent が反転する', () => {
    const m = makeMatch({ deckA: monoDeck('abyss'), deckB: monoDeck('wave') });
    const a = m.snapshot('A');
    const b = m.snapshot('B');
    expect(a.self.hand[0].id).toBe('abyss');
    expect(a.opponent.hand[0].id).toBe('wave');
    expect(b.self.hand[0].id).toBe('wave');
    expect(b.opponent.hand[0].id).toBe('abyss');
  });

  it('未知の playerId は例外', () => {
    const m = makeMatch();
    expect(() => m.snapshot('Z')).toThrow();
    expect(() => m.pressKey('Z', 'a', 0)).toThrow();
    expect(() => m.selectCard('Z', 0, 0)).toThrow();
  });

  it('同じ playerId の2陣営は作れない', () => {
    expect(
      () =>
        new MatchEngine([
          { id: 'X', deck: monoDeck('gale') },
          { id: 'X', deck: monoDeck('gale') },
        ])
    ).toThrow();
  });

  it('start 前は経過0、start で時刻を記録(二重 start は無視)', () => {
    const m = makeMatch();
    expect(m.snapshotTimers('A', 1000).elapsedMs).toBe(0);
    m.start(1000);
    m.start(9999);
    expect(m.snapshotTimers('A', 1500).elapsedMs).toBe(500);
  });
});

describe('相互 HP 削り合い', () => {
  it('A の発動ダメージは B の HP に適用される(自陣 HP は減らない)', () => {
    const m = makeMatch(); // 両者 gale(damage5)
    m.start(0);
    castFull(m, 'A', 0, 'gale', 1000);
    const a = m.snapshot('A');
    expect(a.self.hp).toBe(80); // 自陣は無傷
    expect(a.opponent.hp).toBe(75); // 相手に 5 ダメージ
    // B 視点でも一致
    expect(m.snapshot('B').self.hp).toBe(75);
    expect(m.snapshot('B').opponent.hp).toBe(80);
  });

  it('両者が交互に削り合い、HP が独立して減る', () => {
    const m = makeMatch(); // gale(5)
    m.start(0);
    castFull(m, 'A', 0, 'gale', 1000); // B: 80→75
    castFull(m, 'B', 0, 'gale', 1000); // A: 80→75
    castFull(m, 'A', 1, 'gale', 3000); // B: 75→70
    const a = m.snapshot('A');
    expect(a.self.hp).toBe(75);
    expect(a.opponent.hp).toBe(70);
  });

  it('発動で捨て札・補充・クールダウンが per-side に起きる', () => {
    const m = makeMatch();
    m.start(0);
    castFull(m, 'A', 0, 'gale', 1000);
    const a = m.snapshot('A');
    expect(a.self.discardPileCount).toBe(1);
    expect(a.self.drawPileCount).toBe(15);
    expect(a.self.hand).toHaveLength(4);
    expect(a.self.selectedIndex).toBeNull();
    expect(m.snapshotTimers('A', 1000).selfCooldownRemainingMs).toBe(1500);
    // 相手はクールダウン無し
    expect(m.snapshotTimers('A', 1000).opponentCooldownRemainingMs).toBe(0);
  });

  it('ダメージは詠唱中の誤入力数だけ減る(下限1, ADR 0001)', () => {
    const m = makeMatch();
    m.start(0);
    m.selectCard('A', 0, 0);
    m.pressKey('A', 'q', 0); // 誤入力1
    m.pressKey('A', 'q', 0); // 誤入力2
    const r = romajiOf(byId('gale'));
    for (const k of r) m.pressKey('A', k, 1000);
    expect(m.snapshot('A').opponent.hp).toBe(80 - (5 - 2)); // 3 ダメージ
  });
});

describe('撃破(KO)による勝敗', () => {
  it('先に相手を0にした側が win(撃破)、相手は lose', () => {
    // A は abyss(17)。B の HP を 17 にして 1 発で倒す。
    const m = makeMatch({ deckA: monoDeck('abyss'), deckB: monoDeck('gale'), maxHp: 17 });
    m.start(0);
    castFull(m, 'A', 0, 'abyss', 3000);

    expect(m.finished).toBe(true);
    expect(m.result).toEqual({ winnerId: 'A', endReason: 'ko' });

    const a = m.snapshot('A');
    expect(a.outcome).toEqual({ kind: 'win', endReason: 'ko' });
    expect(a.opponent.hp).toBe(0);
    const b = m.snapshot('B');
    expect(b.outcome).toEqual({ kind: 'lose', endReason: 'ko' });
  });

  it('HP は 0 未満にならず 0 で止まる', () => {
    const m = makeMatch({ deckA: monoDeck('abyss'), maxHp: 10 }); // abyss(17) で過剰
    m.start(0);
    castFull(m, 'A', 0, 'abyss', 1000);
    expect(m.snapshot('A').opponent.hp).toBe(0);
  });

  it('決着後の操作はすべて無視 / blocked になる', () => {
    const m = makeMatch({ deckA: monoDeck('abyss'), maxHp: 17 });
    m.start(0);
    castFull(m, 'A', 0, 'abyss', 1000);
    expect(m.finished).toBe(true);

    expect(m.pressKey('A', 'k', 2000)).toBe('blocked');
    m.selectCard('B', 1, 2000);
    expect(m.snapshot('B').self.selectedIndex).toBeNull();
    // 結果は不変
    expect(m.result).toEqual({ winnerId: 'A', endReason: 'ko' });
  });

  it('発動ごとに即終了せず、同一 atMs の全状態適用後に評価する', () => {
    // B を 1 発で倒せる状況。発動の打鍵列の最後で初めて KO 評価が走る。
    const m = makeMatch({ deckA: monoDeck('abyss'), maxHp: 17 });
    m.start(0);
    m.selectCard('A', 0, 0);
    const r = romajiOf(byId('abyss'));
    // 最後の1打鍵の手前までは未決着
    for (let i = 0; i < r.length - 1; i++) {
      m.pressKey('A', r[i], 1000);
      expect(m.finished).toBe(false);
    }
    // 最後の打鍵で発動 → KO 評価
    m.pressKey('A', r[r.length - 1], 1000);
    expect(m.finished).toBe(true);
  });
});

describe('同一 atMs 両者0 で draw(ADR 0010 #14/#16)', () => {
  it('同じ権威 atMs で双方が相手を0にしたら draw(相打ち)', () => {
    // 両者 abyss(17)・HP17。KO 判定は発動ごとに即確定せず同一 atMs の保留点に積まれる
    // ため、同一 atMs=1000 で A も B も相手を 0 にすると一括評価で双方 ≤0 → draw。
    const m = makeMatch({ deckA: monoDeck('abyss'), deckB: monoDeck('abyss'), maxHp: 17 });
    m.start(0);
    m.selectCard('A', 0, 1000);
    m.selectCard('B', 0, 1000);
    const r = romajiOf(byId('abyss'));
    // A の発動を完了 → B が 0(ただし即確定はせず保留)
    for (const k of r) m.pressKey('A', k, 1000);
    // 同一 atMs=1000 のまま B の発動も完了 → A も 0
    for (const k of r) m.pressKey('B', k, 1000);

    // ここで初めて結果を参照(flush)。一括評価で双方 ≤0 → draw。
    expect(m.result).toEqual({ winnerId: null, endReason: 'ko' });
    expect(m.snapshot('A').outcome).toEqual({ kind: 'draw', endReason: 'ko' });
    expect(m.snapshot('B').outcome).toEqual({ kind: 'draw', endReason: 'ko' });
    expect(m.snapshot('A').self.hp).toBe(0);
    expect(m.snapshot('A').opponent.hp).toBe(0);
  });

  it('atMs が異なれば先に相手を0にした側が勝つ(draw にならない, ADR 0010 #3)', () => {
    // A が atMs=1000 で B を 0 に → 確定保留。B が atMs=2000(別 atMs)で発動しようとすると、
    // pressKey 冒頭の flush で A の KO が確定し、以降 B の打鍵は blocked。
    const m = makeMatch({ deckA: monoDeck('abyss'), deckB: monoDeck('abyss'), maxHp: 17 });
    m.start(0);
    m.selectCard('A', 0, 1000);
    m.selectCard('B', 0, 1000);
    const r = romajiOf(byId('abyss'));
    for (const k of r) m.pressKey('A', k, 1000); // B を 0 に(保留)
    // 別 atMs=2000 の操作で A の KO が確定する
    expect(m.pressKey('B', r[0], 2000)).toBe('blocked');
    expect(m.result).toEqual({ winnerId: 'A', endReason: 'ko' });
  });
});

describe('制限時間切れ(ADR 0010 #3/#16)', () => {
  it('deadline 未満では evaluateTimeUp は何もしない', () => {
    const m = makeMatch({ timeLimitMs: 120_000 });
    m.start(0);
    castFull(m, 'A', 0, 'gale', 1000); // B: 75
    expect(m.evaluateTimeUp(119_999)).toBe(false);
    expect(m.finished).toBe(false);
  });

  it('deadline 超過・残 HP 多い側が win(時間切れ)', () => {
    const m = makeMatch({ timeLimitMs: 120_000 });
    m.start(0);
    castFull(m, 'A', 0, 'gale', 1000); // A は無傷80、B は75
    const ended = m.evaluateTimeUp(120_000);
    expect(ended).toBe(true);
    expect(m.result).toEqual({ winnerId: 'A', endReason: 'timeup' });
    expect(m.snapshot('A').outcome).toEqual({ kind: 'win', endReason: 'timeup' });
    expect(m.snapshot('B').outcome).toEqual({ kind: 'lose', endReason: 'timeup' });
  });

  it('deadline 超過・残 HP 同値なら draw(時間切れ)', () => {
    const m = makeMatch({ timeLimitMs: 120_000 });
    m.start(0);
    // 双方無傷(80=80)で時間切れ
    expect(m.evaluateTimeUp(120_001)).toBe(true);
    expect(m.result).toEqual({ winnerId: null, endReason: 'timeup' });
    expect(m.snapshot('A').outcome).toEqual({ kind: 'draw', endReason: 'timeup' });
    expect(m.snapshot('B').outcome).toEqual({ kind: 'draw', endReason: 'timeup' });
  });

  it('開始前は evaluateTimeUp は何もしない', () => {
    const m = makeMatch();
    expect(m.evaluateTimeUp(999_999)).toBe(false);
    expect(m.finished).toBe(false);
  });

  it('既に撃破で決着していれば時間切れは上書きしない', () => {
    const m = makeMatch({ deckA: monoDeck('abyss'), maxHp: 17, timeLimitMs: 120_000 });
    m.start(0);
    castFull(m, 'A', 0, 'abyss', 1000);
    expect(m.result).toEqual({ winnerId: 'A', endReason: 'ko' });
    expect(m.evaluateTimeUp(200_000)).toBe(false);
    expect(m.result).toEqual({ winnerId: 'A', endReason: 'ko' }); // 不変
  });

  it('remainingMs が経過に応じて減る', () => {
    const m = makeMatch({ timeLimitMs: 120_000 });
    m.start(1000);
    expect(m.snapshotTimers('A', 1000).remainingMs).toBe(120_000);
    expect(m.snapshotTimers('A', 31_000).remainingMs).toBe(90_000);
    expect(m.snapshotTimers('A', 200_000).remainingMs).toBe(0); // 下限0
  });
});

describe('forfeit(放棄, ADR 0011 #8/#12)', () => {
  it('放棄した側は forfeit、相手は win', () => {
    const m = makeMatch();
    m.start(0);
    m.forfeit('A', 5000);
    expect(m.result).toEqual({ winnerId: 'B', endReason: 'forfeit' });
    expect(m.snapshot('A').outcome).toEqual({ kind: 'forfeit', endReason: 'forfeit' });
    expect(m.snapshot('B').outcome).toEqual({ kind: 'win', endReason: 'forfeit' });
  });
});

describe('決定論(ADR 0009 #1 / 0011 #13)', () => {
  /** 同じ入力列・atMs 列・マスター seed で対戦を最後まで進めて結果を要約する。 */
  function runScript(seed: number) {
    const m = new MatchEngine(
      [
        { id: 'A', deck: STARTER_DECK },
        { id: 'B', deck: STARTER_DECK },
      ],
      { maxHp: 80, timeLimitMs: 120_000, masterSeed: seed }
    );
    m.start(0);
    // 決まった台本: 各陣営が手札0を10回、時刻を進めながら発動する。
    let t = 1000;
    for (let n = 0; n < 10; n++) {
      for (const pid of ['A', 'B'] as const) {
        if (m.finished) break;
        const snap = m.snapshot(pid);
        const card = snap.self.hand[0];
        m.selectCard(pid, 0, t);
        const r = romajiOf(card);
        for (const k of r) m.pressKey(pid, k, t);
      }
      t += 2000;
    }
    return {
      a: m.snapshot('A'),
      result: m.result,
      events: m.events.map((e) => `${e.type}:${'playerId' in e ? e.playerId : ''}:${e.atMs}`),
    };
  }

  it('同じ (入力列 + atMs 列 + マスター seed) → 同じ最終状態・outcome・イベント', () => {
    const a = runScript(777);
    const b = runScript(777);
    expect(a.a.self.hp).toBe(b.a.self.hp);
    expect(a.a.opponent.hp).toBe(b.a.opponent.hp);
    expect(a.a.self.hand.map((c) => c.id)).toEqual(b.a.self.hand.map((c) => c.id));
    expect(a.a.self.drawPileCount).toBe(b.a.self.drawPileCount);
    expect(a.result).toEqual(b.result);
    expect(a.events).toEqual(b.events);
  });

  it('陣営の rng は独立ストリーム(マスター seed から派生)', () => {
    // 同一マスター seed・同一デッキでも A と B の初期手札は独立に決まる。
    const m = new MatchEngine(
      [
        { id: 'A', deck: STARTER_DECK },
        { id: 'B', deck: STARTER_DECK },
      ],
      { masterSeed: 12345 }
    );
    const aHand = m.snapshot('A').self.hand.map((c) => c.id);
    const bHand = m.snapshot('B').self.hand.map((c) => c.id);
    // 独立ストリームなので両者の初期手札は一致しない(同一だったら派生が効いていない)。
    expect(aHand).not.toEqual(bHand);
  });

  it('マスター seed が変われば初期配置も変わる', () => {
    const hand = (seed: number) =>
      new MatchEngine(
        [
          { id: 'A', deck: STARTER_DECK },
          { id: 'B', deck: STARTER_DECK },
        ],
        { masterSeed: seed }
      )
        .snapshot('A')
        .self.hand.map((c) => c.id);
    expect(hand(1)).not.toEqual(hand(2));
  });
});

describe('先行入力(type-ahead)が per-side で機能する(ADR 0007)', () => {
  it('クールダウン中の打鍵はバッファされ、明けにドレインで受理・発動する', () => {
    const m = makeMatch(); // gale(5), cooldown1500
    m.start(0);
    castFull(m, 'A', 0, 'gale', 1000); // 発動 → 2500 までクールダウン。B:75
    // クールダウン中に手札1(gale)を構えて全文を先行入力
    m.selectCard('A', 1, 1200);
    const r = romajiOf(byId('gale'));
    for (const k of r) {
      expect(m.pressKey('A', k, 1200)).toBe('buffered');
    }
    // まだ進まない / 相手 HP も変わらない
    expect(m.snapshot('A').opponent.hp).toBe(75);
    // クールダウン明けにドレインすると全文が受理され発動 → さらに 5 ダメージ
    expect(m.drainTypeahead('A', 2500)).toBe(true);
    expect(m.snapshot('A').opponent.hp).toBe(70);
  });
});
