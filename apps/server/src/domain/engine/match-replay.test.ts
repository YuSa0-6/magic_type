import { describe, it, expect } from 'vitest';
import { MatchEngine } from './match';
import type { MatchConfig } from './match';
import { CARDS, STARTER_DECK } from './cards';
import { TypingSession } from './romaji/session';
import type { Card } from './cards';

/**
 * 対戦エンジン A3: コマンドログ + replay + serialize/restore のテスト
 * (ADR 0009 #3/#4, 0011 #4)。
 *
 * 決定論(同じ config + 同じ入力列・atMs 列 → 同じ状態, ADR 0009 #1)を前提に、
 * - replay: あるマッチを進めて commands を記録 → fromCommands で再構成 → 最終 snapshot
 *   (両視点)・outcome・eventLog が一致する。
 * - serialize/restore: 途中で serialize → restore → 以降同じ入力で進めると中断なしと
 *   同一結果になる(進行中詠唱の途中でも一致)。
 * を検証する。
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

/** snapshot を比較しやすいプレーン要約へ落とす(視点別)。 */
function summarize(m: MatchEngine, playerId: string) {
  const s = m.snapshot(playerId);
  const proj = (p: typeof s.self) => ({
    hp: p.hp,
    shield: p.shield,
    hand: p.hand.map((c) => c.id),
    selectedIndex: p.selectedIndex,
    typedRomaji: p.typedRomaji,
    remainingGuide: p.remainingGuide,
    castMistypes: p.castMistypes,
    drawPileCount: p.drawPileCount,
    discardPileCount: p.discardPileCount,
    activeEffects: p.activeEffects.map((e) => ({ ...e })),
  });
  return { self: proj(s.self), opponent: proj(s.opponent), outcome: s.outcome };
}

/** eventLog を比較用に文字列化(視点非依存)。 */
const eventsOf = (m: MatchEngine): string[] => m.events.map((e) => JSON.stringify(e));

describe('コマンドログ(ADR 0009 #3)', () => {
  it('start/select/press/drain を受理順に記録する(eventLog とは別物)', () => {
    const m = new MatchEngine([
      { id: 'A', deck: monoDeck('gale') },
      { id: 'B', deck: monoDeck('gale') },
    ]);
    m.start(0);
    m.selectCard('A', 0, 1000);
    m.pressKey('A', 'k', 1000);
    m.drainTypeahead('A', 1000);

    expect(m.commands).toEqual([
      { type: 'start', atMs: 0 },
      { type: 'select', playerId: 'A', handIndex: 0, atMs: 1000 },
      { type: 'press', playerId: 'A', key: 'k', atMs: 1000 },
      { type: 'drain', playerId: 'A', atMs: 1000 },
    ]);
  });

  it('誤入力・blocked な入力もコマンドとして残る(入力の完全記録)', () => {
    const m = new MatchEngine([
      { id: 'A', deck: monoDeck('gale') },
      { id: 'B', deck: monoDeck('gale') },
    ]);
    m.start(0);
    m.pressKey('A', 'q', 0); // 未選択 → blocked だがコマンドは残る
    expect(m.commands).toEqual([
      { type: 'start', atMs: 0 },
      { type: 'press', playerId: 'A', key: 'q', atMs: 0 },
    ]);
  });
});

describe('replay(fromCommands, ADR 0011 #4)', () => {
  const config: MatchConfig = {
    players: [
      { id: 'A', deck: STARTER_DECK },
      { id: 'B', deck: STARTER_DECK },
    ],
    options: { maxHp: 80, timeLimitMs: 120_000, masterSeed: 4242 },
  };

  /** 決まった台本でマッチを最後まで(または規定回数)進める。 */
  function play(): MatchEngine {
    const m = new MatchEngine(config.players, config.options);
    m.start(0);
    let t = 1000;
    for (let n = 0; n < 8; n++) {
      for (const pid of ['A', 'B'] as const) {
        if (m.finished) break;
        const snap = m.snapshot(pid);
        const card = snap.self.hand[n % 4];
        m.selectCard(pid, n % 4, t);
        // たまに誤入力を1つ混ぜる(誤入力もコマンドに残り再現される)
        if (n % 3 === 0) m.pressKey(pid, 'q', t);
        for (const k of romajiOf(card)) m.pressKey(pid, k, t);
      }
      t += 1700; // クールダウン(1500)をまたぐ刻み
    }
    return m;
  }

  it('記録した commands と同一 config で最終 snapshot(両視点)・outcome・eventLog が一致', () => {
    const original = play();
    const replayed = MatchEngine.fromCommands(config, original.commands);

    expect(summarize(replayed, 'A')).toEqual(summarize(original, 'A'));
    expect(summarize(replayed, 'B')).toEqual(summarize(original, 'B'));
    expect(replayed.result).toEqual(original.result);
    expect(eventsOf(replayed)).toEqual(eventsOf(original));
    // 再構成したエンジンの commands も元と一致する(べき等)。
    expect(replayed.commands).toEqual(original.commands);
  });

  it('途中までの commands で部分再構成しても、同じ tick の状態に一致する', () => {
    const original = play();
    const half = original.commands.slice(0, Math.floor(original.commands.length / 2));
    // 元エンジンを同じ commands 列の前半だけで再生したものと、別途前半 commands を再構成したものが一致。
    const a = MatchEngine.fromCommands(config, half);
    const b = MatchEngine.fromCommands(config, half);
    expect(summarize(a, 'A')).toEqual(summarize(b, 'A'));
    expect(eventsOf(a)).toEqual(eventsOf(b));
  });
});

describe('serialize/restore(ADR 0011 #4)', () => {
  const config: MatchConfig = {
    players: [
      { id: 'A', deck: STARTER_DECK },
      { id: 'B', deck: STARTER_DECK },
    ],
    options: { maxHp: 80, timeLimitMs: 120_000, masterSeed: 9090 },
  };

  it('進めて serialize → restore → 以降同じ入力で進めると中断なしと同一結果', () => {
    // 1 ステップ = 両陣営が手札0を1枚詠唱する。atMs は刻みで進める。
    const step = (m: MatchEngine, n: number) => {
      const t = 1000 + n * 1700;
      for (const pid of ['A', 'B'] as const) {
        if (m.finished) break;
        const card = m.snapshot(pid).self.hand[0];
        m.selectCard(pid, 0, t);
        for (const k of romajiOf(card)) m.pressKey(pid, k, t);
      }
    };

    // 基準: 中断せず 6 ステップ通しで進める。
    const baseline = new MatchEngine(config.players, config.options);
    baseline.start(0);
    for (let n = 0; n < 6; n++) step(baseline, n);

    // 継続: 3 ステップ進めて serialize → restore → 残り 3 ステップ進める。
    const continued = new MatchEngine(config.players, config.options);
    continued.start(0);
    for (let n = 0; n < 3; n++) step(continued, n);
    const restored = MatchEngine.restore(config, continued.serialize());
    for (let n = 3; n < 6; n++) step(restored, n);

    expect(summarize(restored, 'A')).toEqual(summarize(baseline, 'A'));
    expect(summarize(restored, 'B')).toEqual(summarize(baseline, 'B'));
    expect(restored.result).toEqual(baseline.result);
  });

  it('進行中詠唱の途中で serialize → restore しても、続きを打てば同一結果(誤入力数も保存)', () => {
    const baseline = new MatchEngine([
      { id: 'A', deck: monoDeck('abyss') },
      { id: 'B', deck: monoDeck('gale') },
    ]);
    const broken = new MatchEngine([
      { id: 'A', deck: monoDeck('abyss') },
      { id: 'B', deck: monoDeck('gale') },
    ]);
    const cfg: MatchConfig = {
      players: [
        { id: 'A', deck: monoDeck('abyss') },
        { id: 'B', deck: monoDeck('gale') },
      ],
    };

    const r = romajiOf(byId('abyss'));
    const cut = Math.floor(r.length / 2);

    // 基準: A が abyss を最後まで通しで詠唱(途中で誤入力を2回混ぜる)。
    baseline.start(0);
    baseline.selectCard('A', 0, 1000);
    baseline.pressKey('A', 'z', 1000); // 誤入力1
    for (let i = 0; i < cut; i++) baseline.pressKey('A', r[i], 1000);
    baseline.pressKey('A', 'z', 1000); // 誤入力2
    for (let i = cut; i < r.length; i++) baseline.pressKey('A', r[i], 1000);

    // 継続: 途中(cut まで・誤入力1済)で serialize → restore → 残りを打つ。
    broken.start(0);
    broken.selectCard('A', 0, 1000);
    broken.pressKey('A', 'z', 1000); // 誤入力1(serialize 前)
    for (let i = 0; i < cut; i++) broken.pressKey('A', r[i], 1000);

    const dto = broken.serialize();
    // 進行中詠唱は内部 Candidate 形状を出さず selectedReading + typedKeys + mistypes だけ。
    expect(dto.sides[0].cast).not.toBeNull();
    expect(dto.sides[0].cast?.selectedReading).toBe(byId('abyss').reading);
    expect(dto.sides[0].cast?.mistypes).toBe(1);

    const restored = MatchEngine.restore(cfg, dto);
    // 復元直後の入力軸スナップショットが中断側と一致(typedRomaji/誤入力数/残ガイド)。
    expect(summarize(restored, 'A')).toEqual(summarize(broken, 'A'));

    restored.pressKey('A', 'z', 1000); // 誤入力2(restore 後)
    for (let i = cut; i < r.length; i++) restored.pressKey('A', r[i], 1000);

    expect(summarize(restored, 'A')).toEqual(summarize(baseline, 'A'));
    expect(summarize(restored, 'B')).toEqual(summarize(baseline, 'B'));
    // 誤入力2回ぶんダメージが減衰している(abyss 17 - 2 = 15)。
    expect(restored.snapshot('B').self.hp).toBe(80 - (17 - 2));
  });

  it('クールダウン中の先行入力バッファも保存・復元される(ADR 0007)', () => {
    const make = () =>
      new MatchEngine([
        { id: 'A', deck: monoDeck('gale') },
        { id: 'B', deck: monoDeck('gale') },
      ]);
    const cfg: MatchConfig = {
      players: [
        { id: 'A', deck: monoDeck('gale') },
        { id: 'B', deck: monoDeck('gale') },
      ],
    };
    const r = romajiOf(byId('gale'));

    const baseline = make();
    baseline.start(0);
    baseline.selectCard('A', 0, 1000);
    for (const k of r) baseline.pressKey('A', k, 1000); // 発動 → 2500 までCD
    baseline.selectCard('A', 1, 1200);
    for (const k of r) baseline.pressKey('A', k, 1200); // buffered
    baseline.drainTypeahead('A', 2500); // 明けにドレイン発動

    const broken = make();
    broken.start(0);
    broken.selectCard('A', 0, 1000);
    for (const k of r) broken.pressKey('A', k, 1000);
    broken.selectCard('A', 1, 1200);
    for (const k of r) broken.pressKey('A', k, 1200); // buffered
    const dto = broken.serialize();
    expect(dto.sides[0].typeahead.length).toBe(r.length);

    const restored = MatchEngine.restore(cfg, dto);
    restored.drainTypeahead('A', 2500);

    expect(summarize(restored, 'A')).toEqual(summarize(baseline, 'A'));
    expect(restored.snapshot('B').self.hp).toBe(baseline.snapshot('B').self.hp);
  });

  it('決着済み(KO)も serialize/restore でそのまま保たれる', () => {
    const cfg: MatchConfig = {
      players: [
        { id: 'A', deck: monoDeck('abyss') },
        { id: 'B', deck: monoDeck('gale') },
      ],
      options: { maxHp: 17 },
    };
    const m = new MatchEngine(cfg.players, cfg.options);
    m.start(0);
    m.selectCard('A', 0, 1000);
    for (const k of romajiOf(byId('abyss'))) m.pressKey('A', k, 1000);
    expect(m.result).toEqual({ winnerId: 'A', endReason: 'ko' });

    const restored = MatchEngine.restore(cfg, m.serialize());
    expect(restored.result).toEqual({ winnerId: 'A', endReason: 'ko' });
    expect(restored.snapshot('A').outcome).toEqual({ kind: 'win', endReason: 'ko' });
    expect(restored.snapshot('B').self.hp).toBe(0);
    // 決着後の操作は無視される。
    expect(restored.pressKey('A', 'k', 2000)).toBe('blocked');
  });

  it('restore は rng 消費位置まで復元するので、以降の draw 順が一致する', () => {
    const cfg: MatchConfig = {
      players: [
        { id: 'A', deck: STARTER_DECK },
        { id: 'B', deck: STARTER_DECK },
      ],
      options: { masterSeed: 31337 },
    };
    const m = new MatchEngine(cfg.players, cfg.options);
    m.start(0);
    // 数枚消費して rng を進める。
    let t = 1000;
    for (let n = 0; n < 3; n++) {
      const card = m.snapshot('A').self.hand[0];
      m.selectCard('A', 0, t);
      for (const k of romajiOf(card)) m.pressKey('A', k, t);
      t += 1700;
    }
    const dto = m.serialize();
    const restored = MatchEngine.restore(cfg, dto);

    // restore 後に同じ追加入力で進めると、引いてくる手札・山札が完全に一致する。
    const cont = (e: MatchEngine) => {
      let tt = t;
      for (let n = 0; n < 3; n++) {
        const card = e.snapshot('A').self.hand[0];
        e.selectCard('A', 0, tt);
        for (const k of romajiOf(card)) e.pressKey('A', k, tt);
        tt += 1700;
      }
    };
    cont(m);
    cont(restored);
    expect(summarize(restored, 'A')).toEqual(summarize(m, 'A'));
  });
});
