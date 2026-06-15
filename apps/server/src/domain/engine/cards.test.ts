import { describe, it, expect } from 'vitest';
import { CARDS, STARTER_DECK, EFFECT_CARDS } from './cards';
import { TypingSession } from './romaji/session';

/** 最短ローマ字路の打鍵数(詠唱時間の代理, ADR 0010 #12)。 */
const keystrokes = (reading: string): number => new TypingSession(reading).remainingGuide.length;

describe('カードデータの機械検証', () => {
  it('全カードの読みが判定エンジンで変換可能(かな純度)', () => {
    for (const card of CARDS) {
      // 変換できないかなが混ざっていればコンストラクタが投げる
      expect(() => new TypingSession(card.reading)).not.toThrow();
    }
  });

  it('全カードの読みが10〜25かなに収まる(お題規定)', () => {
    for (const card of CARDS) {
      const len = card.reading.length;
      expect(len, `${card.name}`).toBeGreaterThanOrEqual(10);
      expect(len, `${card.name}`).toBeLessThanOrEqual(25);
    }
  });

  it('長いカードほど1打鍵あたりのダメージ効率が高い(非線形リターン)', () => {
    // 効率は damage / 打鍵数(最短ローマ字路の打鍵数)で測る。
    // 詠唱時間=打鍵数律速(ADR 0010 #12)のため、効率の単位は「かな」ではなく「打鍵」。
    const sorted = [...CARDS].sort((a, b) => keystrokes(a.reading) - keystrokes(b.reading));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].damage / keystrokes(sorted[i - 1].reading);
      const curr = sorted[i].damage / keystrokes(sorted[i].reading);
      expect(curr, `${sorted[i].name} は ${sorted[i - 1].name} より効率が高いこと`).toBeGreaterThan(
        prev
      );
    }
  });

  it('カードは10種', () => {
    expect(CARDS.length).toBe(10);
  });

  it('固定デッキは15枚で、同じカードは最大2枚', () => {
    expect(STARTER_DECK.length).toBe(15);
    const counts = new Map<string, number>();
    for (const card of STARTER_DECK) {
      counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      expect(count, id).toBeLessThanOrEqual(2);
    }
  });

  it('カードIDは一意', () => {
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(CARDS.length);
  });
});

describe('効果カードの機械検証(ADR 0010)', () => {
  it('効果カードの読みが判定エンジンで変換可能(かな純度)', () => {
    for (const card of EFFECT_CARDS) {
      expect(() => new TypingSession(card.reading), card.name).not.toThrow();
    }
  });

  it('効果カードは純攻撃カードの最小効率より低い(サブ曲線, ADR 0010 #6)', () => {
    // 純攻撃カード(CARDS)の最小 damage/打鍵(=wave 相当)を基準にする。
    const minAttackEfficiency = Math.min(...CARDS.map((c) => c.damage / keystrokes(c.reading)));
    for (const card of EFFECT_CARDS) {
      const efficiency = card.damage / keystrokes(card.reading);
      expect(efficiency, `${card.name} はサブ曲線(最小効率未満)であること`).toBeLessThan(
        minAttackEfficiency
      );
    }
  });

  it('heal の amount は7以下(亀の封じ込め, ADR 0010 #11)', () => {
    for (const card of EFFECT_CARDS) {
      for (const effect of card.effects) {
        if (effect.kind === 'heal') {
          expect(effect.amount, card.name).toBeLessThanOrEqual(7);
        }
      }
    }
  });

  it('効果カードIDは一意で、純攻撃カードと衝突しない', () => {
    const effectIds = EFFECT_CARDS.map((c) => c.id);
    expect(new Set(effectIds).size).toBe(EFFECT_CARDS.length);
    const attackIds = new Set(CARDS.map((c) => c.id));
    for (const id of effectIds) {
      expect(attackIds.has(id), id).toBe(false);
    }
  });
});
