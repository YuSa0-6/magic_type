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
    const keystrokes = (reading: string): number =>
      new TypingSession(reading).remainingGuide.length;
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

  it('固定デッキは20枚で、同じカードは最大2枚', () => {
    expect(STARTER_DECK.length).toBe(20);
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
