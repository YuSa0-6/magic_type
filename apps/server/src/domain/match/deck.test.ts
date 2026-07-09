import { describe, it, expect } from 'vitest';
import { validateDeck, DECK_SIZE, MAX_PER_CARD, CARD_POOL } from './deck.ts';
import { CARDS, EFFECT_CARDS, QUICK_CARDS } from '../engine/index.ts';

/** ちょうど 15 枚・同種最大 2 の合法デッキ(純攻撃 10 種 + 軽い 5 種をもう 1 枚)。 */
function legalDeckIds(): string[] {
  return [...CARDS.map((c) => c.id), ...CARDS.slice(0, 5).map((c) => c.id)];
}

describe('サーバー側デッキ検証(validateDeck)', () => {
  it('カードプールは純攻撃 10 + 効果 6 + クイック 5 = 21 種', () => {
    expect(CARD_POOL.length).toBe(CARDS.length + EFFECT_CARDS.length + QUICK_CARDS.length);
    expect(CARD_POOL.length).toBe(21);
  });

  it('15 枚・同種最大 2・実在カードなら valid で Card 配列に解決される', () => {
    const result = validateDeck(legalDeckIds());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.deck.length).toBe(DECK_SIZE);
      // 解決された Card は実在カード(id が一致)。
      expect(result.deck.every((c) => CARD_POOL.some((p) => p.id === c.id))).toBe(true);
    }
  });

  it('効果カードを混ぜても 15 枚・同種最大 2 なら valid', () => {
    // 純攻撃 4 種 × 2 + 効果 6 種 × 1 + 純攻撃 1 種 × 1 = 15 枚。
    const ids = [
      ...CARDS.slice(0, 4).flatMap((c) => [c.id, c.id]),
      ...EFFECT_CARDS.map((c) => c.id),
      CARDS[4].id,
    ];
    expect(ids.length).toBe(DECK_SIZE);
    expect(validateDeck(ids).valid).toBe(true);
  });

  it('クイックカードを混ぜても 15 枚・同種最大 2 なら valid(client/server プール整合)', () => {
    // 純攻撃 5 種 × 2 + クイック 5 種 × 1 = 15 枚。web の deck-storage が受理したデッキを
    // サーバーも受理する(QUICK_CARDS をプールに含めたことの回帰)。
    const ids = [
      ...CARDS.slice(0, 5).flatMap((c) => [c.id, c.id]),
      ...QUICK_CARDS.map((c) => c.id),
    ];
    expect(ids.length).toBe(DECK_SIZE);
    expect(validateDeck(ids).valid).toBe(true);
  });

  it('14 枚は invalid(枚数境界・下)', () => {
    const ids = legalDeckIds().slice(0, 14);
    const result = validateDeck(ids);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('15枚'))).toBe(true);
    }
  });

  it('16 枚は invalid(枚数境界・上)', () => {
    const ids = [...legalDeckIds(), CARDS[9].id];
    expect(validateDeck(ids).valid).toBe(false);
  });

  it('同種 3 枚は invalid(同種上限境界)', () => {
    // wave を 3 枚にして合計 15 枚を保つ。
    const ids = [
      CARDS[0].id,
      CARDS[0].id,
      CARDS[0].id, // wave ×3
      ...CARDS.slice(1, 7).flatMap((c) => [c.id, c.id]),
    ];
    expect(ids.length).toBe(DECK_SIZE);
    const result = validateDeck(ids);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes(`最大${MAX_PER_CARD}枚`))).toBe(true);
    }
  });

  it('同種ちょうど 2 枚は valid(上限境界・合格側)', () => {
    expect(validateDeck(legalDeckIds()).valid).toBe(true);
  });

  it('不明なカード ID を含むと invalid', () => {
    const ids = [...legalDeckIds().slice(0, 14), 'NOT_A_CARD'];
    const result = validateDeck(ids);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('不明なカード'))).toBe(true);
    }
  });

  it('空デッキは invalid', () => {
    expect(validateDeck([]).valid).toBe(false);
  });
});
