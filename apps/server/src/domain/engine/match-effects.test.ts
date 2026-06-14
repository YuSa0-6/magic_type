import { describe, it, expect } from 'vitest';
import { MatchEngine } from './match';
import { PlayerSide } from './player-side';
import { CARDS, EFFECT_CARDS } from './cards';
import { TypingSession } from './romaji/session';
import type { Card } from './cards';

/**
 * 対戦エンジン A2: 効果(Effect)ハンドラ6種 + ダメージ解決パイプラインのテスト
 * (ADR 0010 #8/#9/#13/#14/#15/#17)。
 *
 * 機構の細部(shield 吸収・sift の並べ替え・discard の枯渇/詠唱中除外・haste/slow が
 * 次回 CD のみに窓内で効く)は PlayerSide を直接組んで決定論的に検証し、
 * 効果の適用順(ダメージ→自陣バフ→相手デバフ)や相打ち draw の不変性は MatchEngine
 * 越しに検証する。
 */

/** カードの最短ローマ字路(動的ガイド全文)。打鍵列の生成に使う。 */
const romajiOf = (card: Card): string => new TypingSession(card.reading).remainingGuide;

const findCard = (id: string): Card => {
  const c = [...CARDS, ...EFFECT_CARDS].find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
};

const monoDeck = (id: string, n = 20): Card[] => Array.from({ length: n }, () => findCard(id));

/** 固定 rng(列を順に返す。尽きたら 0)。決定論テスト用。 */
const seqRng = (values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++] ?? 0;
};

/** 指定陣営が手札 handIndex のカードを 1 枚詠唱して発動する(全打鍵を時刻 atMs)。 */
function castFull(
  m: MatchEngine,
  playerId: string,
  handIndex: number,
  cardId: string,
  atMs: number
): void {
  m.selectCard(playerId, handIndex, atMs);
  for (const k of romajiOf(findCard(cardId))) {
    m.pressKey(playerId, k, atMs);
  }
}

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

describe('heal: 自陣 HP +amount を maxHp でクランプ(ADR 0010 #14)', () => {
  it('減った HP を回復する', () => {
    const side = new PlayerSide(monoDeck('mend'), 80, seqRng([0]));
    side.takeDamage(20); // 60
    side.heal(6);
    expect(side.hp).toBe(66);
  });

  it('maxHp を超える回復は上限でクランプ(超過分は破棄)', () => {
    const side = new PlayerSide(monoDeck('mend'), 80, seqRng([0]));
    side.takeDamage(3); // 77
    side.heal(6); // 83 → 80 でクランプ
    expect(side.hp).toBe(80);
  });
});

describe('shield: 吸収・貫通・上限加算・据え置き(ADR 0010 #9/#14)', () => {
  it('シールドが被弾を吸収し、超過分のみ HP へ貫通する', () => {
    const side = new PlayerSide(monoDeck('aegis'), 80, seqRng([0]));
    side.addShield(8, 16); // shield 8
    side.takeDamage(5); // 5 吸収 → shield 3, HP 80
    expect(side.shield).toBe(3);
    expect(side.hp).toBe(80);
    side.takeDamage(5); // shield 3 吸収, 2 貫通 → HP 78
    expect(side.shield).toBe(0);
    expect(side.hp).toBe(78);
  });

  it('上限付き加算: 現シールド + amount を capAmount でクランプ', () => {
    const side = new PlayerSide(monoDeck('aegis'), 80, seqRng([0]));
    side.addShield(8, 16); // 8
    side.addShield(8, 16); // 16
    expect(side.shield).toBe(16);
    side.addShield(8, 16); // 24 → cap 16
    expect(side.shield).toBe(16);
  });

  it('既に cap 以上のシールドは加算で減らない(据え置き)', () => {
    const side = new PlayerSide(monoDeck('aegis'), 80, seqRng([0]));
    side.addShield(20, 20); // 20
    side.addShield(5, 16); // min(max(20,16), 25) = 20(減らさない)
    expect(side.shield).toBe(20);
  });
});

describe('haste: 自陣の次回 CD のみ窓内で短縮(進行中 CD 不変, ADR 0010 #13)', () => {
  it('効果適用後に開始する CD が窓内で短縮される', () => {
    const side = new PlayerSide(monoDeck('quicken'), 80, seqRng([0, 0, 0, 0]));
    side.applyHaste(700, 6000, 1000); // 窓 [1000, 7000]
    // quicken を発動(全打鍵を 2000ms)→ 新 CD は 1500 - 700 = 800
    side.selectCard(0);
    for (const k of romajiOf(findCard('quicken'))) side.pressKey(k, 2000);
    expect(side.cooldownRemainingMs(2000)).toBe(800); // 1500-700
  });

  it('進行中の CD は短縮しない(haste は次回以降のみ)', () => {
    const side = new PlayerSide(monoDeck('wave'), 80, seqRng(Array(8).fill(0)));
    // 先に 1 発発動して CD 開始(1500)
    side.selectCard(0);
    for (const k of romajiOf(findCard('wave'))) side.pressKey(k, 1000);
    expect(side.cooldownRemainingMs(1000)).toBe(1500); // 進行中
    // 進行中に haste を付与しても進行中 CD は変わらない
    side.applyHaste(700, 6000, 1100);
    expect(side.cooldownRemainingMs(1100)).toBe(1400); // 1500 - 100 経過のみ(短縮されない)
  });

  it('窓の外で開始する CD には効かない', () => {
    const side = new PlayerSide(monoDeck('wave'), 80, seqRng(Array(8).fill(0)));
    side.applyHaste(700, 1000, 1000); // 窓 [1000, 2000]
    side.selectCard(0);
    for (const k of romajiOf(findCard('wave'))) side.pressKey(k, 5000); // 窓外で発動
    expect(side.cooldownRemainingMs(5000)).toBe(1500); // 短縮なし
  });

  it('スタックはリフレッシュ(窓を上書き・値は最大, ADR 0010 #9)', () => {
    const side = new PlayerSide(monoDeck('wave'), 80, seqRng(Array(8).fill(0)));
    side.applyHaste(700, 6000, 1000); // 窓 [1000, 7000], ms 700
    side.applyHaste(300, 1000, 2000); // 再付与: 窓 [2000, 3000] に上書き(延長しない), 値は max(700,300)=700
    // 4000ms で発動: 上書き後の窓 [2000,3000] の外なので効かない
    side.selectCard(0);
    for (const k of romajiOf(findCard('wave'))) side.pressKey(k, 4000);
    expect(side.cooldownRemainingMs(4000)).toBe(1500);
  });
});

describe('slow: 相手の次回 CD のみ窓内で延長(ADR 0010 #13)', () => {
  it('効果適用後に開始する CD が窓内で延長される', () => {
    const side = new PlayerSide(monoDeck('wave'), 80, seqRng(Array(8).fill(0)));
    side.applySlow(700, 6000, 1000); // 窓 [1000, 7000]
    side.selectCard(0);
    for (const k of romajiOf(findCard('wave'))) side.pressKey(k, 2000);
    expect(side.cooldownRemainingMs(2000)).toBe(2200); // 1500 + 700
  });

  it('進行中 CD は延長しない', () => {
    const side = new PlayerSide(monoDeck('wave'), 80, seqRng(Array(8).fill(0)));
    side.selectCard(0);
    for (const k of romajiOf(findCard('wave'))) side.pressKey(k, 1000); // CD 1500 進行中
    side.applySlow(700, 6000, 1100);
    expect(side.cooldownRemainingMs(1100)).toBe(1400); // 経過分のみ(延長されない)
  });
});

describe('discard: 相手手札1枚入れ替え/枯渇 no-op/詠唱中除外(ADR 0010 #17)', () => {
  it('手札1枚を捨て札へ送り山札から補充する(手札枚数は不変)', () => {
    // 2 種混在デッキで識別可能にする
    const deck = [
      ...Array(2).fill(findCard('wave')),
      ...Array(18).fill(findCard('abyss')),
    ] as Card[];
    const side = new PlayerSide(deck, 80, seqRng([0.0, 0.0])); // shuffle 用 + discard pick 用
    const before = side.snapshot();
    side.discardRandom();
    const after = side.snapshot();
    expect(after.hand).toHaveLength(before.hand.length); // 枚数不変
    expect(after.discardPileCount).toBe(before.discardPileCount + 1); // 捨て札 +1
    expect(after.drawPileCount).toBe(before.drawPileCount - 1); // 山札 -1(補充)
  });

  it('山札も捨て札も空なら no-op(例外を投げない)', () => {
    // 手札4枚ぴったりのデッキ(山札0・捨て札0)
    const deck = Array(4).fill(findCard('wave')) as Card[];
    const side = new PlayerSide(deck, 80, seqRng([0, 0, 0, 0]));
    expect(side.snapshot().drawPileCount).toBe(0);
    expect(side.snapshot().discardPileCount).toBe(0);
    const before = side.snapshot();
    expect(() => side.discardRandom()).not.toThrow();
    const after = side.snapshot();
    expect(after.hand.map((c) => c.id)).toEqual(before.hand.map((c) => c.id)); // 不変
    expect(after.drawPileCount).toBe(0);
    expect(after.discardPileCount).toBe(0);
  });

  it('詠唱中(選択中)のカードは discard 対象外(除外されなければ選ばれる rng でも不変)', () => {
    // 各スロットを識別するため、id を振った別オブジェクトの 20 枚デッキを作る。
    // shuffle を恒等化(rng=0)するので、引いた手札 id 列で位置を追える。
    const deck: Card[] = Array.from({ length: 20 }, (_, i) => ({
      ...findCard('wave'),
      id: `c${i}`,
    }));
    // 20 枚 shuffle は 19 回 rng を消費(Fisher-Yates, i=19..1, rng=0 で恒等)。
    // ドローは pop で rng を消費しない。discard の pick は 20 回目の rng = index 19。
    // 選択中 index=2。除外あり候補 [0,1,3]、除外なし候補 [0,1,2,3]。
    // rng=0.5 → 除外あり: floor(0.5*3)=1 → 候補[1]=hand[1] を捨てる(hand[2] 不変)。
    //         → 除外なし: floor(0.5*4)=2 → hand[2](選択中)を捨てる(hand[2] 入れ替わる)。
    // 除外が効いていれば hand[2] は不変、効いていなければ別 id へ入れ替わる。
    const rngSeq = Array(19).fill(0) as number[];
    rngSeq[19] = 0.5;
    const side = new PlayerSide(deck, 80, seqRng(rngSeq));
    side.selectCard(2);
    const guardedId = side.snapshot().hand[2].id; // 選択中スロットの id を保持
    side.discardRandom();
    expect(side.snapshot().hand[2].id).toBe(guardedId); // 除外が効いていれば id 不変
    expect(side.snapshot().discardPileCount).toBe(1); // no-op ではない(別スロットを捨てた)
  });
});

describe('sift: 上 count 枚の最大 damage を先頭へ(ADR 0010 v1 解釈)', () => {
  it('上 count 枚の最大 damage カードが次ドローへ来る', () => {
    // shuffle を恒等(全 rng=0 → swap 先が常に index 0)にして並びを制御するのは難しいため、
    // sift 後に実際に引いて最大 damage が来ることを検証する。
    // 山札の上 3 枚に wave(3)/abyss(17)/spark(4) を含むよう、ピーク→sift→ピークで確認。
    const deck = [
      findCard('thunder'),
      findCard('spark'),
      findCard('abyss'),
      findCard('wave'),
      findCard('gale'),
      findCard('frost'),
      findCard('meteor'),
      findCard('chasm'),
    ] as Card[];
    // shuffle を恒等化するため rng=0 を多めに渡す(Fisher-Yates で j=0 固定)
    const side = new PlayerSide(deck, 80, seqRng(Array(40).fill(0)));
    const topBefore = side.peekTopDrawPile(3);
    // 上 3 枚のうち最大 damage のカード id
    const maxId = topBefore.reduce((best, id) =>
      findCard(id).damage > findCard(best).damage ? id : best
    );
    side.sift(3);
    expect(side.peekTopDrawPile(1)[0]).toBe(maxId); // 次ドローが最大 damage
  });

  it('山札が空・count<=0 は no-op', () => {
    const empty = new PlayerSide(Array(4).fill(findCard('wave')) as Card[], 80, seqRng([0, 0, 0]));
    expect(empty.snapshot().drawPileCount).toBe(0);
    expect(() => empty.sift(3)).not.toThrow();

    const side = new PlayerSide(monoDeck('gale'), 80, seqRng(Array(40).fill(0)));
    const before = side.peekTopDrawPile(5);
    side.sift(0);
    expect(side.peekTopDrawPile(5)).toEqual(before); // 不変
  });
});

describe('効果の適用順(ダメージ→自陣バフ→相手デバフ)と snapshot 反映(ADR 0010 #15)', () => {
  it('mend(heal+damage)発動でダメージ→自陣回復が起き snapshot に出る', () => {
    // A は mend(damage3 + heal6)。A を先に削っておき、発動で B にダメージ+A 回復を確認。
    const m = makeMatch({ deckA: monoDeck('mend'), deckB: monoDeck('gale') });
    m.start(0);
    castFull(m, 'B', 0, 'gale', 1000); // A: 80→75
    castFull(m, 'A', 0, 'mend', 2000); // B: 80→77, A: 75→81→80(クランプ)
    const a = m.snapshot('A');
    expect(a.opponent.hp).toBe(77); // ダメージ適用
    expect(a.self.hp).toBe(80); // heal で 75→81→80 クランプ
  });

  it('aegis(shield)発動で自陣シールドが立つ', () => {
    const m = makeMatch({ deckA: monoDeck('aegis'), deckB: monoDeck('gale') });
    m.start(0);
    castFull(m, 'A', 0, 'aegis', 1000);
    expect(m.snapshot('A').self.shield).toBe(8);
    // 続けて被弾するとシールドが先に減る
    castFull(m, 'B', 0, 'gale', 2000); // damage5 → shield 8→3, HP 80
    const a = m.snapshot('A');
    expect(a.self.shield).toBe(3);
    expect(a.self.hp).toBe(80);
  });

  it('quicken 発動で自陣 activeEffects に haste が反映される', () => {
    const m = makeMatch({ deckA: monoDeck('quicken'), deckB: monoDeck('gale') });
    m.start(0);
    castFull(m, 'A', 0, 'quicken', 1000);
    const eff = m.snapshot('A').self.activeEffects;
    expect(eff).toHaveLength(1);
    expect(eff[0].kind).toBe('haste');
    expect(eff[0].ms).toBe(700);
    expect(eff[0].expiresAtMs).toBe(7000); // 1000 + 6000
  });

  it('mire(slow)発動で相手の次回 CD が窓内で延長される', () => {
    const m = makeMatch({ deckA: monoDeck('mire'), deckB: monoDeck('gale') });
    m.start(0);
    castFull(m, 'A', 0, 'mire', 1000); // 相手 B に slow 700/6000 を付与
    // B の activeEffects(相手陣)に slow が乗る
    const bEff = m.snapshot('A').opponent.activeEffects;
    expect(bEff).toHaveLength(1);
    expect(bEff[0].kind).toBe('slow');
    // B が次に発動する CD は 1500 + 700 = 2200
    castFull(m, 'B', 0, 'gale', 2000);
    expect(m.snapshotTimers('B', 2000).selfCooldownRemainingMs).toBe(2200);
  });
});

describe('効果はダメージ・相打ち裁定(KO 一括評価)を壊さない(ADR 0010 #14/#16)', () => {
  it('効果カードでも同一 atMs 両者0 の相打ちは draw のまま', () => {
    // 両者 pilfer(damage4, discard 効果)。HP4 で同一 atMs に相互撃破。
    const m = makeMatch({ deckA: monoDeck('pilfer'), deckB: monoDeck('pilfer'), maxHp: 4 });
    m.start(0);
    m.selectCard('A', 0, 1000);
    m.selectCard('B', 0, 1000);
    for (const k of romajiOf(findCard('pilfer'))) m.pressKey('A', k, 1000); // B → 0(保留)
    for (const k of romajiOf(findCard('pilfer'))) m.pressKey('B', k, 1000); // A → 0(保留)
    expect(m.result).toEqual({ winnerId: null, endReason: 'ko' });
  });

  it('shield 越しの貫通ダメージで KO 判定される', () => {
    // B は aegis でシールド 8。A の abyss(17)で shield 8 控除 → 9 貫通。HP9 で KO。
    const m = makeMatch({ deckA: monoDeck('abyss'), deckB: monoDeck('aegis'), maxHp: 9 });
    m.start(0);
    castFull(m, 'B', 0, 'aegis', 1000); // B: shield 8
    castFull(m, 'A', 0, 'abyss', 2000); // 17: 8 吸収 + 9 貫通 → B HP 0
    expect(m.result).toEqual({ winnerId: 'A', endReason: 'ko' });
    expect(m.snapshot('A').opponent.hp).toBe(0);
  });
});

describe('決定論: 同じ入力列 + atMs + seed → 同じ結果(ADR 0009 #1)', () => {
  function runEffectScript(seed: number) {
    const m = new MatchEngine(
      [
        { id: 'A', deck: [...EFFECT_CARDS, ...EFFECT_CARDS] },
        { id: 'B', deck: [...EFFECT_CARDS, ...EFFECT_CARDS] },
      ],
      { maxHp: 80, timeLimitMs: 120_000, masterSeed: seed }
    );
    m.start(0);
    let t = 1000;
    for (let n = 0; n < 6; n++) {
      for (const pid of ['A', 'B'] as const) {
        if (m.finished) break;
        const card = m.snapshot(pid).self.hand[0];
        m.selectCard(pid, 0, t);
        for (const k of romajiOf(card)) m.pressKey(pid, k, t);
      }
      t += 2000;
    }
    const a = m.snapshot('A');
    const b = m.snapshot('B');
    return {
      aHp: a.self.hp,
      aShield: a.self.shield,
      bHp: b.self.hp,
      bShield: b.self.shield,
      aHand: a.self.hand.map((c) => c.id),
      aEffects: a.self.activeEffects.map((e) => `${e.kind}:${e.ms}:${e.expiresAtMs}`),
      bEffects: b.self.activeEffects.map((e) => `${e.kind}:${e.ms}:${e.expiresAtMs}`),
      events: m.events.map((e) => `${e.type}:${'playerId' in e ? e.playerId : ''}:${e.atMs}`),
    };
  }

  it('効果カードを使う台本でも同 seed で完全一致する', () => {
    expect(runEffectScript(2024)).toEqual(runEffectScript(2024));
  });
});
