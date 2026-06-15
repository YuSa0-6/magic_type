/**
 * 対戦の権威ループ・コーディネータ `MatchSession`(B2, ADR 0011 #1/#2/#10/#16)。純 TS。
 *
 * `MatchEngine` を 1 つ保持し、クライアントの打鍵ストリームをサーバー権威で実行して
 * 状態デルタを両陣営へ push する土台になる。DO(lib)はこの純 TS を「メモリ常駐 +
 * setInterval(時間 tick)+ WebSocket 送信」で駆動するだけの薄い配線にする(ADR 0004)。
 *
 * ── 入力遅延つき遅延権威シミュレーション(ラグ補償, ADR 0011「入力遅延による権威
 *    シミュレーション」)──────────────────────────────────────────────────────
 *  根因(監査 blocker, ADR 0010 #16): MatchEngine は「同一 atMs を隣接させたグローバル
 *  順序列」を前提にした遅延 KO 評価(pendingKoAtMs + flushPendingKo(nextAtMs))を持つ。
 *  入力を到着順に即適用すると、A のバッチが KO 後の後続 atMs を含むだけで auto-flush が
 *  走り、まだ適用していない B の同一 atMs 入力より先に A の win が確定する。これで厳密な
 *  同時撃破の draw(#16)が片側 win に化ける。
 *
 *  解法: applyInput を「engine へ即適用」から「バッファへ積むだけ」に変える。確定(KO 評価・
 *  時間切れ)は tick の遅延権威クロック `authClock = nowMs - INPUT_DELAY_MS` でのみ起きる。
 *  tick ごとに atMs <= authClock の両者入力をバッファから取り出し、グローバルに
 *  (atMs, playerId) で安定ソートして engine へ順に適用する。INPUT_DELAY ぶん遅らせることで
 *  「両者の atMs=T の入力は authClock が T を越える前に必ずバッファに揃う」ことを保証し、
 *  ソートで同一 atMs が隣接 → 解決前に両方適用される。auto-flush(engine)もソート列なら
 *  同一 atMs 隣接が保たれるため整合し、厳密な同時撃破も draw になる。
 *
 *  不変条件(旧「読まないから安全」を置換): 確定は tick の flush 境界・遅延権威クロックで
 *  のみ起きる。applyInput は engine を一切呼ばず副作用がない(snapshot/finished も読まない)。
 *  snapshot/delta も読む直前に flush するが、tick で既に authClock まで適用済みなので
 *  「未適用の同一 atMs 入力を取りこぼした状態を確定させる」ことはない。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * アンチチート初歩(ADR 0011 #2 / バランスレビュー):
 *  - atMs はサーバー受信時刻(nowMs)でクランプし、過去/未来の自己申告を是正する。
 *  - 単調性: 既に確定した権威時刻(lastConfirmedAtMs)より前へは丸める(時間を巻き戻させ
 *    ない=遅すぎる入力のペナルティ)。これは「確定済みの過去」基準なので両陣営共通。
 *  - 未着席 / 未開始 / 終了後の入力は無視する。
 *  - 極端な kps の本格的な統計ベース検知は B3 以降。ここでは「クランプ + 単調化」までを
 *    土台とする。重要: クランプは等号を維持する(同一 atMs はそのまま保つ)。同一 atMs に
 *    両者が相手を 0 にした相打ち(draw, ADR 0010 #16)を別 atMs にずらして win に化けさせ
 *    ないため、連続打鍵を最小間隔へ"広げる"ことはしない。
 */

import type {
  MatchConfig,
  MatchEngine,
  MatchOutcome,
  MatchSnapshot,
  MatchTimers,
} from '../engine/index.ts';

/**
 * クライアント → サーバーの 1 入力コマンド(B2, ADR 0011 #2)。
 * 打鍵ストリーム権威: クライアントは全 keydown を press として送る。select は手札の構え。
 * atMs はクライアント主張の権威時刻だが、サーバーが受信時刻でクランプ・単調化する。
 */
export type InputCommand =
  | { readonly kind: 'select'; readonly handIndex: number; readonly atMs: number }
  | { readonly kind: 'press'; readonly key: string; readonly atMs: number };

/**
 * 入力遅延(ラグ補償)の権威クロックオフセット(ミリ秒)。tunable。
 *
 * サーバーは「現在時刻より INPUT_DELAY_MS だけ過去」を権威クロック(authClock)として
 * 進める。この遅延の根拠は「想定 RTT + ジッタを吸収し、両者の同一 atMs 入力を解決(KO 評価)
 * の前に必ずバッファへ揃えるため」。片側の atMs=T の入力が届く前に authClock が T を越えると
 * 同一 atMs の相打ち(ADR 0010 #16)を取りこぼすので、INPUT_DELAY は片道遅延 + ジッタの
 * 現実的な上限を見込む。代償は権威確定が INPUT_DELAY 遅れることだが、自陣の体感はクライアント
 * のローカル予測(B3, ADR 0011 #1/#9)で吸収するためゼロに保てる。
 */
export const INPUT_DELAY_MS = 150;

/**
 * push 用ペイロード(server → client の `state`, 10Hz, ADR 0008/0011 #2)。
 * 入力軸 snapshot(self/opponent)+ 時間軸 timers + 視点別 outcome をまとめる。
 * 相手の個別打鍵は送らず、意味のある状態(HP・詠唱進捗・効果・CD・決着)だけを送る。
 */
export interface StatePayload {
  readonly self: MatchSnapshot['self'];
  readonly opponent: MatchSnapshot['opponent'];
  readonly timers: MatchTimers;
  readonly outcome: MatchOutcome;
}

/** バッファ内の 1 入力(クランプ済み権威 atMs + 発行元 playerId + コマンド)。 */
interface BufferedInput {
  readonly playerId: string;
  readonly atMs: number;
  readonly command: InputCommand;
}

/**
 * 権威ループのコーディネータ。1 マッチ = 1 インスタンス(DO が保持)。
 * 副作用(時刻・WebSocket 送信・setInterval)は持たず、すべて呼び出し側が注入する。
 */
export class MatchSession {
  private readonly engine: MatchEngine;
  private readonly ids: readonly [string, string];

  /** 開始済みか(start を 1 度だけ呼ぶためのフラグ)。 */
  private started = false;

  /** 権威開始時刻(authClock の下限)。未開始は null。 */
  private startAtMs: number | null = null;

  /**
   * 遅延権威クロックで「ここまで engine へ適用した」最後の権威時刻。
   * tick ごとに authClock へ単調に進める。atMs のクランプ下限(巻き戻し不可)と、
   * timers / snapshot を一貫した権威時刻で算出するための基準を兼ねる。
   */
  private lastConfirmedAtMs = 0;

  /**
   * 未適用の入力バッファ(両陣営をまたいだグローバル列)。enqueueInput が積み、
   * tick が atMs <= authClock の分を (atMs, playerId) 安定ソートして取り出す。
   * atMs > authClock は次 tick へ残す(まだ権威が追いついていない未来の入力)。
   */
  private buffer: BufferedInput[] = [];

  /** 前回 push 時の入力軸シグネチャ(視点別)。デルタ送信要否の判定に使う。 */
  private readonly lastSignature: Record<string, string> = {};

  constructor(engine: MatchEngine, config: MatchConfig) {
    this.engine = engine;
    this.ids = [config.players[0].id, config.players[1].id];
  }

  /** 既知の playerId か(未着席・未知 id の入力を弾く土台)。 */
  private isKnown(playerId: string): boolean {
    return playerId === this.ids[0] || playerId === this.ids[1];
  }

  /**
   * 対戦の権威開始時刻を記録する(冪等)。DO は matchStart 直後に 1 度呼ぶ。
   * 時間軸の deadline(startAtMs + timeLimitMs)はここで基準が決まる(ADR 0011 #10)。
   * authClock の下限・lastConfirmedAtMs の初期値も startAtMs に揃える。
   */
  start(atMs: number): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.startAtMs = atMs;
    this.lastConfirmedAtMs = atMs;
    this.engine.start(atMs);
  }

  /**
   * クライアントの入力バッチを「バッファへ積む」だけ(遅延権威 sim, ADR 0011 ラグ補償)。
   *
   * 旧 applyInput と異なり engine へは一切適用しない(snapshot/finished も読まない)。
   * 各コマンドの atMs を [lastConfirmedAtMs, nowMs] にクランプして権威 atMs を決め
   * (アンチチート, ADR 0011 #2)、buffer へ積むだけ。実適用・KO 評価・時間切れは tick の
   * 遅延権威クロックでのみ起きる。未開始・未知 id・終了後は無視する。
   *
   * 後方互換のため applyInput という名は残す(DO の配線/テストが呼ぶ)。
   */
  applyInput(playerId: string, commands: readonly InputCommand[], nowMs: number): void {
    this.enqueueInput(playerId, commands, nowMs);
  }

  /**
   * クライアントの入力バッチをバッファへ積む(遅延権威 sim の入口)。
   * applyInput の実体。意味を明示する別名として export 経路にも載せる。
   */
  enqueueInput(playerId: string, commands: readonly InputCommand[], nowMs: number): void {
    // 未開始・未知 id・決着後は積まない(終了後入力ゲートを buffer 段で弾く)。
    if (!this.started || !this.isKnown(playerId) || this.engine.finished) {
      return;
    }
    for (const cmd of commands) {
      const atMs = this.clampAtMs(cmd.atMs, nowMs);
      // クランプ後の atMs を権威時刻として buffer へ積む(元 cmd の atMs は使わない)。
      this.buffer.push({ playerId, atMs, command: { ...cmd, atMs } });
    }
  }

  /**
   * クライアント主張 atMs を権威 atMs にクランプする(アンチチート, ADR 0011 #2)。
   * - 非有限は nowMs に倒す。
   * - 未来(nowMs より先)は nowMs に丸める(先の時刻を主張して deadline を飛び越えさせない)。
   * - 既に確定した時刻(lastConfirmedAtMs より前)は lastConfirmedAtMs に丸める(遅すぎる
   *   入力のペナルティ。tick で既に authClock=T まで適用・確定済みなら、後から届いた T 未満の
   *   入力は T へ寄せて決定論を保つ。等号は許す)。
   * 巻き戻し不可。等号維持(同一 atMs はそのまま)なので相打ち draw 契約を壊さない。
   */
  private clampAtMs(claimedAtMs: number, nowMs: number): number {
    let atMs = Number.isFinite(claimedAtMs) ? claimedAtMs : nowMs;
    if (atMs > nowMs) {
      atMs = nowMs;
    }
    if (atMs < this.lastConfirmedAtMs) {
      atMs = this.lastConfirmedAtMs; // 確定済みの過去へは戻せない(等号は維持)。
    }
    return atMs;
  }

  /**
   * 遅延権威クロックを nowMs - INPUT_DELAY_MS へ進め、揃ったバッファ入力を確定する
   * (ラグ補償, ADR 0011)。順序:
   *   ① authClock = clampMonotonic(nowMs - INPUT_DELAY_MS)(startAtMs 未満にしない・
   *      lastConfirmedAtMs 以上へ単調)。
   *   ② buffer から atMs <= authClock を全取り出し、(atMs, playerId) 安定ソートして
   *      engine へ順に適用(selectCard / pressKey)。atMs > authClock は次 tick へ残す。
   *   ③ 両陣営 drainTypeahead(authClock)→ evaluateTimeUp(authClock)→ flush()。
   *   ④ lastConfirmedAtMs = authClock。
   * これで両者の atMs=T 入力は authClock が T を越える前にバッファへ揃い、ソートで隣接 →
   * 解決前に両方適用 = 厳密な同時撃破も draw(ADR 0010 #16)。終了したか(finished)を返す。
   */
  tick(nowMs: number): boolean {
    if (!this.started || this.engine.finished) {
      return this.engine.finished;
    }
    const authClock = this.authClockAt(nowMs);

    // ② 揃った入力(atMs <= authClock)を取り出し、グローバルに (atMs, playerId) 安定ソート。
    const ready: BufferedInput[] = [];
    const remaining: BufferedInput[] = [];
    for (const input of this.buffer) {
      if (input.atMs <= authClock) {
        ready.push(input);
      } else {
        remaining.push(input);
      }
    }
    this.buffer = remaining;
    ready.sort(compareInputs);
    for (const input of ready) {
      const cmd = input.command;
      if (cmd.kind === 'select') {
        this.engine.selectCard(input.playerId, cmd.handIndex, input.atMs);
      } else {
        this.engine.pressKey(input.playerId, cmd.key, input.atMs);
      }
    }

    // ③ 先行入力ドレイン(片側 KO の早漏れを避けるため両方先に)→ 時間切れ → flush。
    this.engine.drainTypeahead(this.ids[0], authClock);
    this.engine.drainTypeahead(this.ids[1], authClock);
    this.engine.evaluateTimeUp(authClock);
    this.engine.flush();

    // ④ 権威確定点を進める(次回 tick / クランプ / timers の基準)。
    this.lastConfirmedAtMs = authClock;
    return this.engine.finished;
  }

  /**
   * 遅延権威クロックを算出する(nowMs - INPUT_DELAY_MS を単調・下限付きで丸める)。
   * - startAtMs 未満にはしない(開始前の deadline 計算 / 負経過を避ける)。
   * - lastConfirmedAtMs 以上へ単調(authClock は決して巻き戻さない)。
   */
  private authClockAt(nowMs: number): number {
    const lowerBound = this.startAtMs ?? 0;
    const raw = nowMs - INPUT_DELAY_MS;
    return Math.max(this.lastConfirmedAtMs, lowerBound, raw);
  }

  /**
   * 指定視点の push 用ペイロードを返す(順序契約: 直前に flush)。
   * snapshot(入力軸)+ timers(遅延権威クロック依存)+ outcome をまとめる。
   * timers は authClock(直近 tick の lastConfirmedAtMs)で算出して権威状態と一貫させる
   * (nowMs 生で読むと表示上の経過時間が権威確定より進んで見えるため)。
   */
  snapshotFor(playerId: string, nowMs: number): StatePayload {
    this.engine.flush();
    const snap = this.engine.snapshot(playerId);
    const timers = this.engine.snapshotTimers(playerId, this.authClockAt(nowMs));
    return {
      self: snap.self,
      opponent: snap.opponent,
      timers,
      outcome: snap.outcome,
    };
  }

  /**
   * デルタ判定つきの push ペイロードを返す(10Hz 上限は呼び出し側の tick 間隔で担保)。
   *
   * 「入力軸が前回 push から変わったか」(self/opponent の入力軸 snapshot + outcome の
   * シグネチャ比較)で送信要否を決める。timers は毎 tick 動くため送信判定には含めない
   * (送るときには最新 timers を必ず同梱する)。変化が無ければ null(送らない)。
   * timers は snapshotFor と同じく遅延権威クロックで算出する。
   */
  deltaFor(playerId: string, nowMs: number): StatePayload | null {
    this.engine.flush();
    const snap = this.engine.snapshot(playerId);
    const signature = signatureOf(snap);
    if (this.lastSignature[playerId] === signature) {
      return null;
    }
    this.lastSignature[playerId] = signature;
    return {
      self: snap.self,
      opponent: snap.opponent,
      timers: this.engine.snapshotTimers(playerId, this.authClockAt(nowMs)),
      outcome: snap.outcome,
    };
  }

  /** 決着済みか(順序契約: engine.finished が内部で flush する)。 */
  get finished(): boolean {
    return this.engine.finished;
  }

  /** 権威的な決着結果(視点非依存)。未決着は null。 */
  get result(): { winnerId: string | null; endReason: string } | null {
    return this.engine.result;
  }

  /** 直近 tick で確定した権威時刻(テスト/将来用。authClock の進みを観測する)。 */
  get confirmedAtMs(): number {
    return this.lastConfirmedAtMs;
  }
}

/**
 * バッファ入力のグローバル安定ソート比較器(ADR 0010 #15 / #16)。
 * 第一に atMs 昇順(早い権威時刻が先)、同一 atMs は playerId で安定化する。
 * 同一 atMs を隣接させることで engine の auto-flush でも相打ち draw が保たれる。
 * playerId 比較は決定論のための安定タイブレークで、勝敗には影響しない(同一 atMs の
 * 全発動を適用しきってから一括評価するため、適用順は KO 裁定に効かない)。
 */
function compareInputs(a: BufferedInput, b: BufferedInput): number {
  if (a.atMs !== b.atMs) {
    return a.atMs - b.atMs;
  }
  if (a.playerId < b.playerId) {
    return -1;
  }
  if (a.playerId > b.playerId) {
    return 1;
  }
  return 0;
}

/**
 * 入力軸 snapshot + outcome のシグネチャ(デルタ送信要否の判定用)。
 * 時間軸(timers)は含めない(毎 tick 動くため)。意味のある状態変化(HP・詠唱進捗・
 * 効果・手札・山札・決着)が変わったときだけシグネチャが変わるようにする。
 */
function signatureOf(snap: MatchSnapshot): string {
  return JSON.stringify({
    s: sideSig(snap.self),
    o: sideSig(snap.opponent),
    r: snap.outcome,
  });
}

/** 1 陣営の入力軸シグネチャ(snapshot に含まれる atMs 非依存の意味ある値)。 */
function sideSig(s: MatchSnapshot['self']): unknown {
  return {
    hp: s.hp,
    shield: s.shield,
    hand: s.hand.map((c) => c.id),
    sel: s.selectedIndex,
    typed: s.typedRomaji,
    guide: s.remainingGuide,
    mis: s.castMistypes,
    draw: s.drawPileCount,
    disc: s.discardPileCount,
    eff: s.activeEffects,
  };
}
