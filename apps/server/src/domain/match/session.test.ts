import { describe, it, expect } from 'vitest';
import { MatchEngine } from '../engine/match.ts';
import { CARDS } from '../engine/cards.ts';
import { TypingSession } from '../engine/romaji/session.ts';
import type { Card } from '../engine/cards.ts';
import { MatchSession, type InputCommand } from './session.ts';

/**
 * MatchSession(権威ループ・コーディネータ B2)のテスト。
 *
 * 順序契約(同一 atMs の全適用 → flush → 読み, ADR 0010 #14)・決定論・時間切れ・
 * 終了後入力の無視・push ペイロード構造・アンチチート(atMs クランプ)を検証する。
 * 純 TS の MatchSession を中心に担保し、DO レベルは型/build で検証する(報告参照)。
 */

const byId = (id: string): Card => {
  const c = CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
};

/** 指定カードだけで構成した N 枚デッキ(手札・山札が全てそのカードになり制御が容易)。 */
const monoDeck = (id: string, n = 20): Card[] => Array.from({ length: n }, () => byId(id));

/** カードの最短ローマ字路(打鍵列の生成に使う)。 */
const romajiOf = (card: Card): string => new TypingSession(card.reading).remainingGuide;

/** MatchConfig 相当(MatchEngine と MatchSession の両方に渡す)。 */
function makeConfig(opts?: {
  deckA?: Card[];
  deckB?: Card[];
  maxHp?: number;
  timeLimitMs?: number;
  masterSeed?: number;
}) {
  return {
    players: [
      { id: 'A', deck: opts?.deckA ?? monoDeck('gale') },
      { id: 'B', deck: opts?.deckB ?? monoDeck('gale') },
    ] as const,
    options: {
      maxHp: opts?.maxHp,
      timeLimitMs: opts?.timeLimitMs,
      masterSeed: opts?.masterSeed,
    },
  };
}

/** engine + session を対で作る(順序契約のため同一 config を共有)。 */
function makeSession(opts?: Parameters<typeof makeConfig>[0]) {
  const config = makeConfig(opts);
  const engine = new MatchEngine(config.players, config.options);
  const session = new MatchSession(engine, config);
  return { engine, session };
}

/** 1 カードを詠唱しきる input コマンド列(select + 全打鍵を atMs に並べる)。 */
function castCommands(handIndex: number, cardId: string, atMs: number): InputCommand[] {
  const cmds: InputCommand[] = [{ kind: 'select', handIndex, atMs }];
  for (const key of romajiOf(byId(cardId))) {
    cmds.push({ kind: 'press', key, atMs });
  }
  return cmds;
}

describe('MatchSession: 基本の権威ループ', () => {
  it('両者の入力を applyInput → tick で進めると相互 HP が削れる', () => {
    const { session } = makeSession(); // 両者 gale(damage5)
    session.start(0);
    // nowMs を十分大きく取り atMs クランプの影響を受けないようにする。
    session.applyInput('A', castCommands(0, 'gale', 1000), 10_000);
    session.applyInput('B', castCommands(0, 'gale', 1000), 10_000);
    session.tick(1000);
    const a = session.snapshotFor('A', 1000);
    expect(a.self.hp).toBe(75); // B の発動で A も 75(両者削れる)
    expect(a.opponent.hp).toBe(75);
  });

  it('片方を 0 にすると matchEnd(win/lose)へ至る', () => {
    // A は abyss(17)、HP17 にして 1 発で B を倒す。
    const { session } = makeSession({
      deckA: monoDeck('abyss'),
      deckB: monoDeck('gale'),
      maxHp: 17,
    });
    session.start(0);
    session.applyInput('A', castCommands(0, 'abyss', 1000), 100_000);
    const finished = session.tick(1000);
    expect(finished).toBe(true);
    expect(session.finished).toBe(true);
    expect(session.result).toEqual({ winnerId: 'A', endReason: 'ko' });
    expect(session.snapshotFor('A', 1000).outcome).toEqual({ kind: 'win', endReason: 'ko' });
    expect(session.snapshotFor('B', 1000).outcome).toEqual({ kind: 'lose', endReason: 'ko' });
  });

  it('決定論: 同 seed + 同入力 + 同 atMs 列 → 同結果', () => {
    const run = () => {
      const { session } = makeSession({ masterSeed: 0xabc123, maxHp: 30 });
      session.start(0);
      session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
      session.applyInput('B', castCommands(0, 'gale', 1000), 100_000);
      session.tick(1000);
      session.applyInput('A', castCommands(0, 'gale', 3000), 100_000);
      session.tick(3000);
      return session.snapshotFor('A', 3000);
    };
    expect(run()).toEqual(run());
  });
});

describe('MatchSession: 順序契約(相打ち draw)', () => {
  it('同一 atMs で両者が相手を 0 にする → flush 後の評価で draw', () => {
    // 両者 abyss(17)、HP17。同一 atMs に両者の詠唱を適用しきってから評価する。
    const { session } = makeSession({
      deckA: monoDeck('abyss'),
      deckB: monoDeck('abyss'),
      maxHp: 17,
    });
    session.start(0);
    // A・B の入力を同一 atMs=1000 で両方 applyInput してから tick(読みは tick 後)。
    session.applyInput('A', castCommands(0, 'abyss', 1000), 100_000);
    session.applyInput('B', castCommands(0, 'abyss', 1000), 100_000);
    const finished = session.tick(1000);
    expect(finished).toBe(true);
    expect(session.result).toEqual({ winnerId: null, endReason: 'ko' });
    expect(session.snapshotFor('A', 1000).outcome).toEqual({ kind: 'draw', endReason: 'ko' });
    expect(session.snapshotFor('B', 1000).outcome).toEqual({ kind: 'draw', endReason: 'ko' });
  });

  it('順序契約: 先に A の入力だけ適用しても tick まで KO を確定させない(途中読みしない)', () => {
    const { session } = makeSession({
      deckA: monoDeck('abyss'),
      deckB: monoDeck('abyss'),
      maxHp: 17,
    });
    session.start(0);
    session.applyInput('A', castCommands(0, 'abyss', 1000), 100_000);
    // ここで B の入力もまだ同一 atMs=1000。B を適用してから tick → draw。
    session.applyInput('B', castCommands(0, 'abyss', 1000), 100_000);
    session.tick(1000);
    expect(session.result).toEqual({ winnerId: null, endReason: 'ko' });
  });
});

describe('MatchSession: 時間切れ(権威タイマ)', () => {
  it('deadline 超過 tick で残 HP の多い側 win', () => {
    // 制限時間 5000ms。A が 1 発削ってから時間切れにする。
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
    session.tick(1000); // B: 80→75
    expect(session.finished).toBe(false);
    // deadline = 0 + 5000。超過 tick で時間切れ判定。
    const finished = session.tick(5000);
    expect(finished).toBe(true);
    expect(session.result).toEqual({ winnerId: 'A', endReason: 'timeup' });
    expect(session.snapshotFor('A', 5000).outcome).toEqual({ kind: 'win', endReason: 'timeup' });
  });

  it('deadline 超過 tick で残 HP 同値なら draw', () => {
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    // 誰も削らず時間切れ → 両者 80 で draw。
    const finished = session.tick(5000);
    expect(finished).toBe(true);
    expect(session.result).toEqual({ winnerId: null, endReason: 'timeup' });
    expect(session.snapshotFor('B', 5000).outcome).toEqual({ kind: 'draw', endReason: 'timeup' });
  });

  it('deadline 未満の tick では決着しない', () => {
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    expect(session.tick(4999)).toBe(false);
    expect(session.finished).toBe(false);
  });
});

describe('MatchSession: 終了後入力の無視', () => {
  it('決着後の applyInput は無視され、結果が変わらない', () => {
    const { session } = makeSession({ deckA: monoDeck('abyss'), maxHp: 17 });
    session.start(0);
    session.applyInput('A', castCommands(0, 'abyss', 1000), 100_000);
    session.tick(1000);
    expect(session.finished).toBe(true);
    // 終了後に B が大量打鍵しても無視。
    session.applyInput('B', castCommands(0, 'abyss', 2000), 100_000);
    session.tick(2000);
    expect(session.result).toEqual({ winnerId: 'A', endReason: 'ko' });
    expect(session.snapshotFor('B', 2000).self.hp).toBe(0);
  });

  it('start 前の applyInput は無視される', () => {
    const { session } = makeSession();
    session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
    session.start(0);
    session.tick(1000);
    // start 前の入力は捨てられているので相手 HP は満タンのまま。
    expect(session.snapshotFor('A', 1000).opponent.hp).toBe(80);
  });

  it('未知 playerId の入力は無視される', () => {
    const { session } = makeSession();
    session.start(0);
    session.applyInput('Z', castCommands(0, 'gale', 1000), 100_000);
    session.tick(1000);
    expect(session.snapshotFor('A', 1000).opponent.hp).toBe(80);
  });
});

describe('MatchSession: push ペイロード構造', () => {
  it('snapshotFor は self / opponent / timers / outcome を含む', () => {
    const { session } = makeSession();
    session.start(0);
    const p = session.snapshotFor('A', 500);
    expect(p.self.hp).toBe(80);
    expect(p.opponent.hp).toBe(80);
    expect(p.timers.elapsedMs).toBe(500);
    expect(p.timers.remainingMs).toBe(MATCH_TIME_DEFAULT - 500);
    expect(p.outcome).toEqual({ kind: 'ongoing' });
  });

  it('deltaFor: 入力軸が変わらなければ null、変われば送る', () => {
    const { session } = makeSession();
    session.start(0);
    // 初回は必ず送る(前回 push 無し)。
    expect(session.deltaFor('A', 100)).not.toBeNull();
    // 変化が無ければ null(入力軸はそのまま)。
    expect(session.deltaFor('A', 200)).toBeNull();
    // B が削ると A 視点の入力軸(opponent / self HP)が変わる → 送る。
    session.applyInput('B', castCommands(0, 'gale', 300), 100_000);
    session.tick(300);
    expect(session.deltaFor('A', 300)).not.toBeNull();
  });
});

describe('MatchSession: アンチチート(atMs クランプ)', () => {
  it('未来 atMs(nowMs 超過)は nowMs にクランプされる', () => {
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    // 主張 atMs=999999 だが nowMs=1000 なので 1000 に丸められる。詠唱は受理される。
    const cmds = castCommands(0, 'gale', 999_999);
    session.applyInput('A', cmds, 1000);
    session.tick(1000);
    // 発動は受理されているので相手は削れる(未来主張で deadline を飛び越えていない)。
    expect(session.snapshotFor('A', 1000).opponent.hp).toBe(75);
    // deadline(5000)を未来主張で飛び越えていない(時間切れになっていない)。
    expect(session.finished).toBe(false);
  });

  it('過去 atMs(単調性違反)は直前 atMs にクランプされる(巻き戻し不可)', () => {
    const { session } = makeSession();
    session.start(0);
    // 1 打鍵を atMs=5000 で受理 → 次に atMs=100 を主張しても 5000 以降へ丸める。
    session.applyInput('A', [{ kind: 'select', handIndex: 0, atMs: 5000 }], 10_000);
    session.applyInput('A', [{ kind: 'press', key: 'k', atMs: 100 }], 10_000);
    // 巻き戻しで例外/desync が起きないこと(snapshot が読める)。
    expect(() => session.snapshotFor('A', 10_000)).not.toThrow();
  });
});

/** snapshotFor のテストで使う既定制限時間(MATCH_DEFAULT_TIME_LIMIT_MS と同値)。 */
const MATCH_TIME_DEFAULT = 120_000;
