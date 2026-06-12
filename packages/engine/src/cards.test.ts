import { describe, it, expect } from 'vitest';
import { CARDS, STARTER_DECK } from './cards';
import { TypingSession } from './romaji/session';

describe('カードデータの機械検証', () => {
  it('全カードの読みが判定エンジンで変換可能(かな純度)', () => {
    for (const card of CARDS) {
      // 変換できないかなが混ざっていればコンストラクタが投げる
      expect(() => new TypingSession(card.reading)).not.toThrow();
    }
  });

  it('読みの長さがカードの強さ帯に収まる', () => {
    for (const card of CARDS) {
      const len = card.reading.length;
      if (card.damage <= 6) {
        expect(len, `${card.name}(短)`).toBeGreaterThanOrEqual(10);
        expect(len, `${card.name}(短)`).toBeLessThanOrEqual(12);
      } else if (card.damage <= 11) {
        expect(len, `${card.name}(中)`).toBeGreaterThanOrEqual(15);
        expect(len, `${card.name}(中)`).toBeLessThanOrEqual(18);
      } else {
        expect(len, `${card.name}(長)`).toBeGreaterThanOrEqual(22);
        expect(len, `${card.name}(長)`).toBeLessThanOrEqual(25);
      }
    }
  });

  it('長いカードほど1かなあたりのダメージ効率が高い(非線形リターン)', () => {
    const sorted = [...CARDS].sort((a, b) => a.reading.length - b.reading.length);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].damage / sorted[i - 1].reading.length;
      const curr = sorted[i].damage / sorted[i].reading.length;
      expect(curr, `${sorted[i].name} は ${sorted[i - 1].name} より効率が高いこと`).toBeGreaterThan(
        prev
      );
    }
  });

  it('固定デッキは10枚で、同じカードは最大2枚', () => {
    expect(STARTER_DECK.length).toBe(10);
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
