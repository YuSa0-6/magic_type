import { describe, it, expect } from 'vitest';
import { MatchEngine } from '../engine/match.ts';
import { CARDS } from '../engine/cards.ts';
import { TypingSession } from '../engine/romaji/session.ts';
import type { Card } from '../engine/cards.ts';
import { MatchSession, INPUT_DELAY_MS, type InputCommand } from './session.ts';

/**
 * MatchSession(入力遅延つき遅延権威シミュレーション B2, ADR 0011 ラグ補償)のテスト。
 *
 * 新モデル: applyInput/enqueueInput はバッファへ積むだけで engine を呼ばない。確定(KO 評価・
 * 時間切れ)は tick の遅延権威クロック authClock = nowMs - INPUT_DELAY_MS でのみ起きる。
 * tick は authClock 以下の両者入力を (atMs, playerId) 安定ソートして適用するため、厳密な
 * 同時撃破(同一 atMs 相打ち)も draw(ADR 0010 #16)になる。
 *
 * ある atMs=T の入力を確定させるには `tick(T + INPUT_DELAY_MS 以上)` を呼ぶ必要がある。
 * 検証対象: 遅延権威の進み・ソート適用・相打ち draw(現実形の回帰込み)・決定論・時間切れ・
 * 終了後入力の無視・push ペイロード構造・アンチチート(atMs クランプ)。
 * DO レベルの配線は match-room.test.ts、細粒度の engine ルールは engine 側テストで担保する。
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

/** atMs=T の入力を確定させるための tick 時刻(遅延権威クロックが T 以上になる最小)。 */
const confirmAt = (atMs: number): number => atMs + INPUT_DELAY_MS;

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

describe('MatchSession: 基本の遅延権威ループ', () => {
  it('両者の入力を enqueue → tick(遅延ぶん後)で進めると相互 HP が削れる', () => {
    const { session } = makeSession(); // 両者 gale(damage5)
    session.start(0);
    // nowMs を十分大きく取り atMs クランプの影響を受けないようにする。
    session.applyInput('A', castCommands(0, 'gale', 1000), 10_000);
    session.applyInput('B', castCommands(0, 'gale', 1000), 10_000);
    // atMs=1000 は authClock が 1000 以上になる tick で初めて確定する。
    session.tick(confirmAt(1000));
    const a = session.snapshotFor('A', confirmAt(1000));
    expect(a.self.hp).toBe(75); // B の発動で A も 75(両者削れる)
    expect(a.opponent.hp).toBe(75);
  });

  it('atMs=T の入力は authClock が T を越える tick まで確定しない(遅延確定)', () => {
    const { session } = makeSession();
    session.start(0);
    session.applyInput('A', castCommands(0, 'gale', 1000), 10_000);
    // authClock = 1000 - INPUT_DELAY_MS = 850 < 1000 なのでまだ未適用。
    session.tick(1000);
    expect(session.snapshotFor('B', 1000).self.hp).toBe(80); // まだ被弾しない
    expect(session.confirmedAtMs).toBe(1000 - INPUT_DELAY_MS);
    // authClock が 1000 以上になる tick で初めて適用される。
    session.tick(confirmAt(1000));
    expect(session.snapshotFor('B', confirmAt(1000)).self.hp).toBe(75);
    expect(session.confirmedAtMs).toBe(1000);
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
    const finished = session.tick(confirmAt(1000));
    expect(finished).toBe(true);
    expect(session.finished).toBe(true);
    expect(session.result).toEqual({ winnerId: 'A', endReason: 'ko' });
    const t = confirmAt(1000);
    expect(session.snapshotFor('A', t).outcome).toEqual({ kind: 'win', endReason: 'ko' });
    expect(session.snapshotFor('B', t).outcome).toEqual({ kind: 'lose', endReason: 'ko' });
  });

  it('決定論: 同 seed + 同入力 + 同 atMs 列 + 同 tick 列 → 同結果', () => {
    const run = () => {
      const { session } = makeSession({ masterSeed: 0xabc123, maxHp: 30 });
      session.start(0);
      session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
      session.applyInput('B', castCommands(0, 'gale', 1000), 100_000);
      session.tick(confirmAt(1000));
      session.applyInput('A', castCommands(0, 'gale', 3000), 100_000);
      session.tick(confirmAt(3000));
      return session.snapshotFor('A', confirmAt(3000));
    };
    expect(run()).toEqual(run());
  });
});

describe('MatchSession: 遅延権威の相打ち draw(ADR 0010 #16)', () => {
  it('同一 atMs で両者が相手を 0 にする → ソート適用 + flush で draw', () => {
    // 両者 abyss(17)、HP17。同一 atMs の両者入力を同一 tick で適用しきってから評価する。
    const { session } = makeSession({
      deckA: monoDeck('abyss'),
      deckB: monoDeck('abyss'),
      maxHp: 17,
    });
    session.start(0);
    session.applyInput('A', castCommands(0, 'abyss', 1000), 100_000);
    session.applyInput('B', castCommands(0, 'abyss', 1000), 100_000);
    const finished = session.tick(confirmAt(1000));
    expect(finished).toBe(true);
    expect(session.result).toEqual({ winnerId: null, endReason: 'ko' });
    const t = confirmAt(1000);
    expect(session.snapshotFor('A', t).outcome).toEqual({ kind: 'draw', endReason: 'ko' });
    expect(session.snapshotFor('B', t).outcome).toEqual({ kind: 'draw', endReason: 'ko' });
  });

  it('回帰(監査 blocker): A=[致死@T, select@T+δ] と B=[致死@T] を別 enqueue + KO 後の後続 atMs を含む現実形でも draw', () => {
    // 監査の根因再現: A のバッチが KO 後の後続 atMs(select@T+1)を含むと、旧モデルでは
    // engine の auto-flush(flushPendingKo(nextAtMs))が走り、まだ届いていない B の同一
    // atMs 入力より先に A の win が確定して draw が片側 win に化けた。
    // 新モデルは authClock で両者の atMs=T 入力が揃ってから (atMs, playerId) ソートして
    // 適用するため、T の相打ちが解決 → draw になる(T+1 の select は次に適用される)。
    const T = 1000;
    const { session } = makeSession({
      deckA: monoDeck('abyss'),
      deckB: monoDeck('abyss'),
      maxHp: 17,
    });
    session.start(0);
    // A: 致死詠唱@T のあとに別 atMs の select@T+1 を同一バッチで(KO 後の後続 atMs)。
    const aCmds: InputCommand[] = [
      ...castCommands(0, 'abyss', T),
      { kind: 'select', handIndex: 1, atMs: T + 1 },
    ];
    session.applyInput('A', aCmds, 100_000);
    // B: 致死詠唱@T を別メッセージ(別 enqueue)で、A の後に到着。
    session.applyInput('B', castCommands(0, 'abyss', T), 100_000);
    // tick 群を回す: まず T を確定(両者の T 入力が揃ってソート適用 → draw)、
    // 続けて T+1 も含む tick(終了後で T+1 の select は無効)。
    session.tick(confirmAt(T));
    session.tick(confirmAt(T + 1));
    expect(session.result).toEqual({ winnerId: null, endReason: 'ko' });
    const t = confirmAt(T + 1);
    expect(session.snapshotFor('A', t).outcome).toEqual({ kind: 'draw', endReason: 'ko' });
    expect(session.snapshotFor('B', t).outcome).toEqual({ kind: 'draw', endReason: 'ko' });
  });

  it('回帰: A の致死バッチを先に enqueue → tick しても、後着の B の同一 atMs を取りこぼさず draw', () => {
    // A をまず tick せずに enqueue だけしておき(authClock がまだ T 未満の段階で B が来る)、
    // その後に B を enqueue → authClock が T を越える tick で両者が揃って draw になる。
    const T = 2000;
    const { session } = makeSession({
      deckA: monoDeck('abyss'),
      deckB: monoDeck('abyss'),
      maxHp: 17,
    });
    session.start(0);
    session.applyInput('A', castCommands(0, 'abyss', T), 100_000);
    // authClock < T の間は適用されないので、ここで tick しても KO 確定しない。
    session.tick(T); // authClock = T - 150 < T
    expect(session.finished).toBe(false);
    // 後から B の同一 atMs 入力が届く(バッファにまだ A の T 入力が残っている)。
    session.applyInput('B', castCommands(0, 'abyss', T), 100_000);
    session.tick(confirmAt(T)); // 両者の T が揃って適用 → draw
    expect(session.result).toEqual({ winnerId: null, endReason: 'ko' });
  });
});

describe('MatchSession: atMs 順適用(到着順ではない)', () => {
  it('後着の早 atMs が先着の遅 atMs より先に適用される', () => {
    // B(damage5 gale)が atMs=1000、A(damage17 abyss)が atMs=2000。enqueue は A→B の順
    // (到着順では A が先)だが、ソート適用で atMs=1000 の B が先に効く。
    // HP12 にすると: B の 5 ダメージで A は 12→7(生存)、その後 A の 17 で B が KO。
    // もし到着順(A の 2000 が先)なら A が即 KO で B の 1000 が無効化されるが、
    // 遅延 sim では 1 tick に両方揃えてソートするので atMs 順になる。
    const T_LATE = 2000;
    const T_EARLY = 1000;
    const { session } = makeSession({
      deckA: monoDeck('abyss'),
      deckB: monoDeck('gale'),
      maxHp: 12,
    });
    session.start(0);
    // A の遅い入力を先に enqueue、B の早い入力を後に enqueue(到着順 = A→B)。
    session.applyInput('A', castCommands(0, 'abyss', T_LATE), 100_000);
    session.applyInput('B', castCommands(0, 'gale', T_EARLY), 100_000);
    // 両方が authClock 以下になる tick で一括ソート適用(atMs 1000→2000 の順)。
    session.tick(confirmAt(T_LATE));
    // A が勝つ(B を KO)。B の早撃ち 5 ダメージは A に通っているが致死ではない。
    expect(session.result).toEqual({ winnerId: 'A', endReason: 'ko' });
    expect(session.snapshotFor('A', confirmAt(T_LATE)).self.hp).toBe(7); // 12 - 5(B の gale)
  });
});

describe('MatchSession: 遅すぎる入力のクランプ(決定論)', () => {
  it('authClock を過ぎた atMs は lastConfirmedAtMs に丸められ決定論が保たれる', () => {
    const { session } = makeSession({ deckA: monoDeck('abyss'), maxHp: 17 });
    session.start(0);
    // 先に atMs=5000 の入力を確定させて lastConfirmedAtMs を 5000 へ進める。
    session.applyInput('A', [{ kind: 'select', handIndex: 0, atMs: 5000 }], 100_000);
    session.tick(confirmAt(5000));
    expect(session.confirmedAtMs).toBe(5000);
    // 確定済み(5000)より前の atMs=100 を主張しても 5000 へ丸められる(巻き戻し不可)。
    // 丸めた結果 authClock=5000 以下なので次 tick で適用される(取りこぼさない)。
    session.applyInput(
      'A',
      [{ kind: 'press', key: romajiOf(byId('abyss'))[0], atMs: 100 }],
      100_000
    );
    // 例外/desync なく適用され、snapshot が読める(決定論が壊れない)。
    expect(() => session.tick(confirmAt(5000) + 100)).not.toThrow();
    expect(() => session.snapshotFor('A', confirmAt(5000) + 100)).not.toThrow();
  });
});

describe('MatchSession: 時間切れ(遅延権威タイマ)', () => {
  it('deadline 超過の authClock で残 HP の多い側 win', () => {
    // 制限時間 5000ms。A が 1 発削ってから時間切れにする。
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
    session.tick(confirmAt(1000)); // B: 80→75
    expect(session.finished).toBe(false);
    // deadline = 0 + 5000。authClock が 5000 を越える tick で時間切れ判定。
    const finished = session.tick(confirmAt(5000));
    expect(finished).toBe(true);
    expect(session.result).toEqual({ winnerId: 'A', endReason: 'timeup' });
    expect(session.snapshotFor('A', confirmAt(5000)).outcome).toEqual({
      kind: 'win',
      endReason: 'timeup',
    });
  });

  it('deadline 超過の authClock で残 HP 同値なら draw', () => {
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    // 誰も削らず時間切れ → 両者 80 で draw。
    const finished = session.tick(confirmAt(5000));
    expect(finished).toBe(true);
    expect(session.result).toEqual({ winnerId: null, endReason: 'timeup' });
    expect(session.snapshotFor('B', confirmAt(5000)).outcome).toEqual({
      kind: 'draw',
      endReason: 'timeup',
    });
  });

  it('authClock が deadline 未満の tick では決着しない(遅延ぶん遅れて時間切れになる)', () => {
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    // nowMs=5000 でも authClock = 5000 - 150 = 4850 < deadline(5000) なので未決着。
    expect(session.tick(5000)).toBe(false);
    expect(session.finished).toBe(false);
  });
});

describe('MatchSession: 終了後入力の無視', () => {
  it('決着後の applyInput は無視され、結果が変わらない', () => {
    const { session } = makeSession({ deckA: monoDeck('abyss'), maxHp: 17 });
    session.start(0);
    session.applyInput('A', castCommands(0, 'abyss', 1000), 100_000);
    session.tick(confirmAt(1000));
    expect(session.finished).toBe(true);
    // 終了後に B が大量打鍵しても enqueue 段で弾かれる(engine.finished ガード)。
    session.applyInput('B', castCommands(0, 'abyss', 2000), 100_000);
    session.tick(confirmAt(2000));
    expect(session.result).toEqual({ winnerId: 'A', endReason: 'ko' });
    expect(session.snapshotFor('B', confirmAt(2000)).self.hp).toBe(0);
  });

  it('start 前の applyInput は無視される', () => {
    const { session } = makeSession();
    session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
    session.start(0);
    session.tick(confirmAt(1000));
    // start 前の入力は積まれていないので相手 HP は満タンのまま。
    expect(session.snapshotFor('A', confirmAt(1000)).opponent.hp).toBe(80);
  });

  it('未知 playerId の入力は無視される', () => {
    const { session } = makeSession();
    session.start(0);
    session.applyInput('Z', castCommands(0, 'gale', 1000), 100_000);
    session.tick(confirmAt(1000));
    expect(session.snapshotFor('A', confirmAt(1000)).opponent.hp).toBe(80);
  });
});

describe('MatchSession: push ペイロード構造', () => {
  it('snapshotFor は self / opponent / timers(遅延権威クロック)/ outcome を含む', () => {
    const { session } = makeSession();
    session.start(0);
    // nowMs=650 → authClock = 650 - 150 = 500。timers は authClock で算出される。
    const now = 500 + INPUT_DELAY_MS;
    const p = session.snapshotFor('A', now);
    expect(p.self.hp).toBe(80);
    expect(p.opponent.hp).toBe(80);
    expect(p.timers.elapsedMs).toBe(500); // authClock 基準の経過時間
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
    session.tick(confirmAt(300));
    expect(session.deltaFor('A', confirmAt(300))).not.toBeNull();
  });
});

describe('MatchSession: アンチチート(atMs クランプ)', () => {
  it('未来 atMs(nowMs 超過)は nowMs にクランプされる', () => {
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    // 主張 atMs=999999 だが nowMs=1000 なので 1000 に丸められる。詠唱は受理される。
    const cmds = castCommands(0, 'gale', 999_999);
    session.applyInput('A', cmds, 1000);
    // クランプ後 atMs=1000 を確定させる tick(authClock >= 1000)。
    session.tick(confirmAt(1000));
    // 発動は受理されているので相手は削れる(未来主張で deadline を飛び越えていない)。
    expect(session.snapshotFor('A', confirmAt(1000)).opponent.hp).toBe(75);
    // deadline(5000)を未来主張で飛び越えていない(時間切れになっていない)。
    expect(session.finished).toBe(false);
  });

  it('過去 atMs(確定済みより前)は lastConfirmedAtMs にクランプされる(巻き戻し不可)', () => {
    const { session } = makeSession();
    session.start(0);
    // atMs=5000 を確定 → lastConfirmedAtMs=5000。次に atMs=100 を主張しても 5000 へ丸める。
    session.applyInput('A', [{ kind: 'select', handIndex: 0, atMs: 5000 }], 10_000);
    session.tick(confirmAt(5000));
    session.applyInput('A', [{ kind: 'press', key: 'k', atMs: 100 }], 10_000);
    // 巻き戻しで例外/desync が起きないこと(snapshot が読める)。
    expect(() => session.snapshotFor('A', confirmAt(5000) + 100)).not.toThrow();
  });
});

describe('MatchSession: 一時停止と権威時計の凍結(B3, ADR 0011 #8/#11)', () => {
  it('pause 中は tick が権威時計を進めない(凍結)', () => {
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    // 一度 atMs=1000 を確定して authClock を進めておく。
    session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
    session.tick(confirmAt(1000));
    expect(session.confirmedAtMs).toBe(1000);
    // pause 後はどれだけ tick しても confirmedAtMs(権威時計)が進まない。
    session.pause(confirmAt(1000));
    session.tick(confirmAt(1000) + 10_000);
    session.tick(confirmAt(1000) + 50_000);
    expect(session.paused).toBe(true);
    expect(session.confirmedAtMs).toBe(1000);
    // 凍結中は deadline(5000)を実時間で超えても時間切れにならない。
    expect(session.finished).toBe(false);
  });

  it('resume 後は停止していた実時間ぶんだけ権威時計がオフセットされる', () => {
    const { session } = makeSession({ timeLimitMs: 5000 });
    session.start(0);
    session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
    session.tick(confirmAt(1000)); // confirmedAtMs = 1000
    // 実時刻 nowMs=2000 で 10_000ms 停止(2000 → 12000)。
    session.pause(2000);
    session.resume(12_000); // 停止ぶん 10_000ms を pausedOffset へ畳み込む
    // 再開直後、実時刻 12000 でも権威ウォールは 12000-10000=2000 相当。
    // authClock = 2000 - INPUT_DELAY(150) = 1850 → confirmedAtMs まで進む。
    session.tick(12_000);
    expect(session.confirmedAtMs).toBe(1850);
    // 元の deadline(5000)は「停止ぶん 10_000ms 後ろへずれる」ので、実時刻で
    // 5000 + 10_000 = 15_000 を越える tick で初めて時間切れになる。
    expect(session.tick(14_000)).toBe(false); // 権威ウォール 4000 < deadline 5000
    expect(session.finished).toBe(false);
    expect(session.tick(15_000 + INPUT_DELAY_MS)).toBe(true); // 権威ウォール 5000 >= deadline
    expect(session.result?.endReason).toBe('timeup');
  });

  it('凍結中に相手の haste/CD を稼げない(停止ぶんは権威時刻に通算されない)', () => {
    // gale は CD を生む。pause/resume を挟んでも CD 残りは「停止ぶんを除いた経過」で減る。
    const { session } = makeSession();
    session.start(0);
    session.applyInput('A', castCommands(0, 'gale', 1000), 100_000);
    session.tick(confirmAt(1000)); // A 発動 → A に CD が乗る
    const cdAfterCast = session.snapshotFor('A', confirmAt(1000)).timers.selfCooldownRemainingMs;
    expect(cdAfterCast).toBeGreaterThan(0);
    // 実時刻で長時間停止しても、停止ぶんは CD 経過に通算されない(凍結, #11)。
    session.pause(confirmAt(1000));
    session.resume(confirmAt(1000) + 30_000); // 30s 停止
    // 再開直後の権威ウォールは停止前と同じなので CD はほぼ据え置き(停止で稼げていない)。
    session.tick(confirmAt(1000) + 30_000);
    const cdAfterPause = session.snapshotFor('A', confirmAt(1000) + 30_000).timers
      .selfCooldownRemainingMs;
    // 停止が CD 回復に効くなら 0 になっているはず。凍結が効いていれば CD はまだ残っている。
    expect(cdAfterPause).toBeGreaterThan(0);
  });

  it('forfeit: 指定プレイヤーの放棄で相手 win・本人 lose に決着する', () => {
    const { session } = makeSession();
    session.start(0);
    expect(session.forfeit('A', 1000)).toBe(true);
    expect(session.result).toEqual({ winnerId: 'B', endReason: 'forfeit' });
    expect(session.snapshotFor('A', 1000).outcome).toEqual({
      kind: 'forfeit',
      endReason: 'forfeit',
    });
    expect(session.snapshotFor('B', 1000).outcome).toEqual({ kind: 'win', endReason: 'forfeit' });
  });

  it('forfeit: 停止中でも放棄は確定する(猶予超過の権威イベント)', () => {
    const { session } = makeSession();
    session.start(0);
    session.pause(1000);
    expect(session.forfeit('B', 31_000)).toBe(true);
    expect(session.result).toEqual({ winnerId: 'A', endReason: 'forfeit' });
  });

  it('未開始 / 未知 id の pause・forfeit は無視される', () => {
    const { session } = makeSession();
    // 未開始では pause/forfeit とも何も起きない。
    session.pause(1000);
    expect(session.paused).toBe(false);
    expect(session.forfeit('A', 1000)).toBe(false);
    session.start(0);
    // 未知 id の forfeit は無視(決着しない)。
    expect(session.forfeit('Z', 1000)).toBe(false);
    expect(session.finished).toBe(false);
  });
});

/** snapshotFor のテストで使う既定制限時間(MATCH_DEFAULT_TIME_LIMIT_MS と同値)。 */
const MATCH_TIME_DEFAULT = 120_000;

describe('MatchSession: serialize/restore + 時間切れ deadline 換算(ADR 0012)', () => {
  it('serialize → restore で権威クロックと進行状態が一致する(decision continuity)', () => {
    const config = makeConfig({ deckA: monoDeck('gale'), deckB: monoDeck('gale') });
    const engine = new MatchEngine(config.players, config.options);
    const session = new MatchSession(engine, config);
    session.start(0);
    // A が 1 枚詠唱して B を削る(意味的状態変化)。
    session.enqueueInput('A', castCommands(0, 'gale', 100), 100);
    session.tick(confirmAt(100));
    const hpBefore = session.snapshotFor('B', confirmAt(100)).self.hp;
    const confirmedBefore = session.confirmedAtMs;
    const sigBefore = session.stateSignature();
    expect(hpBefore).toBeLessThan(80);

    // serialize → 別エンジン/セッションへ restore(DO 退避→復元の擬似)。
    const engineDto = engine.serialize();
    const sessionDto = session.serialize();
    const engine2 = MatchEngine.restore(config, engineDto);
    const session2 = MatchSession.restore(engine2, config, sessionDto);

    // 復元後の権威状態が一致する(HP・確定権威時刻・シグネチャ)。
    expect(session2.snapshotFor('B', confirmAt(100)).self.hp).toBe(hpBefore);
    expect(session2.confirmedAtMs).toBe(confirmedBefore);
    expect(session2.stateSignature()).toBe(sigBefore);
    expect(session2.finished).toBe(false);

    // 復元後に続けて打つと、中断なしと同じく削れ続ける(決定論)。
    session2.enqueueInput('A', castCommands(0, 'gale', 2000), 2000);
    session2.tick(confirmAt(2000));
    expect(session2.snapshotFor('B', confirmAt(2000)).self.hp).toBeLessThan(hpBefore);
  });

  it('未確定の入力バッファも serialize/restore を跨いで保持される', () => {
    const { engine, session } = makeSession({ deckA: monoDeck('gale'), deckB: monoDeck('gale') });
    session.start(0);
    // authClock が届かない未来の atMs へ積む(tick しても確定しない=バッファに残る)。
    session.enqueueInput('A', castCommands(0, 'gale', 5000), 5000);
    session.tick(confirmAt(0)); // 5000 はまだ未確定(バッファに残る)。
    const config = makeConfig({ deckA: monoDeck('gale'), deckB: monoDeck('gale') });
    const session2 = MatchSession.restore(
      MatchEngine.restore(config, engine.serialize()),
      config,
      session.serialize()
    );
    // 復元後に authClock を 5000 まで進めると、保持されていたバッファ入力が確定して削れる。
    expect(session2.snapshotFor('B', confirmAt(0)).self.hp).toBe(80);
    session2.tick(confirmAt(5000));
    expect(session2.snapshotFor('B', confirmAt(5000)).self.hp).toBeLessThan(80);
  });

  it('pause 状態も restore され、resume の凍結オフセットが連続する', () => {
    const { engine, session } = makeSession();
    session.start(1000);
    session.pause(2000); // 実時刻 2000 で凍結。
    const config = makeConfig();
    const session2 = MatchSession.restore(
      MatchEngine.restore(config, engine.serialize()),
      config,
      session.serialize()
    );
    expect(session2.paused).toBe(true);
    // 凍結中は時間切れ deadline 換算が null(誤発火しない)。
    expect(session2.timeLimitDeadlineWallMs()).toBeNull();
    // 再開すると凍結ぶん(2000→12000 = 10000ms)が pausedOffset へ畳まれ、deadline が後ろへずれる。
    session2.resume(12_000);
    expect(session2.paused).toBe(false);
  });

  it('timeLimitDeadlineWallMs は 開始時刻 + 制限時間 + INPUT_DELAY + 凍結ぶん を返す', () => {
    const { session } = makeSession({ timeLimitMs: 60_000 });
    expect(session.timeLimitDeadlineWallMs()).toBeNull(); // 未開始は null。
    session.start(1000);
    // auth deadline = 1000 + 60000、壁時計換算 = + INPUT_DELAY、凍結ぶん 0。
    expect(session.timeLimitDeadlineWallMs()).toBe(1000 + 60_000 + INPUT_DELAY_MS);
    // 10000ms 凍結すると deadline がその分後ろへずれる(pause 追従)。
    session.pause(5000);
    session.resume(15_000); // 凍結 10000ms。
    expect(session.timeLimitDeadlineWallMs()).toBe(1000 + 60_000 + INPUT_DELAY_MS + 10_000);
  });

  it('決着後は時間切れ deadline 換算が null(予約不要)', () => {
    const { session } = makeSession({ timeLimitMs: 10_000 });
    session.start(0);
    session.forfeit('A', 1000); // B の win で決着。
    expect(session.finished).toBe(true);
    expect(session.timeLimitDeadlineWallMs()).toBeNull();
  });
});
