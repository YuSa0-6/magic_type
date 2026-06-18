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
 *  「両者の atMs=T の入力は authClock が T を越える前に必ずバッファへ揃う」ことを保証し、
 *  ソートで同一 atMs が隣接 → 解決前に両方適用される。auto-flush(engine)もソート列なら
 *  同一 atMs 隣接が保たれるため整合し、厳密な同時撃破も draw になる。
 *
 *  不変条件(旧「読まないから安全」を置換): 確定は tick の flush 境界・遅延権威クロックで
 *  のみ起きる。applyInput は engine を一切呼ばず副作用がない(snapshot/finished も読まない)。
 *  snapshot/delta も読む直前に flush するが、tick で既に authClock まで適用済みなので
 *  「未適用の同一 atMs 入力を取りこぼした状態を確定させる」ことはない。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── 切断猶予つき一時停止(B3, ADR 0011 #8/#11)──────────────────────────────
 *  切断後の再接続猶予のあいだは権威時計を凍結する(pause/resume)。pause すると tick が
 *  一切進まず、authClock は `nowMs - INPUT_DELAY_MS - pausedOffsetMs` で算出されるため、
 *  停止していた実時間ぶんだけ権威時刻が過去に留まる。これで制限時間・effect 失効・CD・
 *  castTime のすべてが停止ぶんオフセットされ、切断側が一時停止で自分の CD 回復や相手 haste
 *  の失効を稼ぐ悪用を防ぐ(#11)。猶予超過は forfeit で決着させる(#8/#12)。
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

import {
  MATCH_DEFAULT_TIME_LIMIT_MS,
  type MatchConfig,
  type MatchEngine,
  type MatchOutcome,
  type MatchSnapshot,
  type MatchTimers,
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
 * `MatchSession` の権威クロック状態の直列化(プレーンデータ, ADR 0012)。
 *
 * engine の状態は `MatchEngine.serialize()` が別に持つので、ここは「session が独自に持つ
 * 権威時計の進み・一時停止オフセット・未確定の入力バッファ」だけを直列化する。DO が
 * `ctx.storage` へ engine DTO と一緒に書き、起動時に `restore` で復元する。これで DO 退避・
 * 再起動後も authClock / lastConfirmedAtMs / pausedOffset が一致し、決定論と時計が壊れない。
 *
 * pausedSinceMs(壁時計の停止開始時刻)は復元側で「停止していた=要再開待ち」かどうかの
 * 真偽だけが本質的に意味を持つ(再開時に nowMs との差分が pausedOffset へ畳まれるため)。
 * 退避→復元では停止していた実時間も経過しているが、復元後に DO が現況を再評価して resume/
 * forfeit を判断するため、ここでは「停止していたか(pausedSinceMs !== null)」を素直に保存する。
 */
export interface MatchSessionDTO {
  readonly started: boolean;
  readonly startAtMs: number | null;
  readonly lastConfirmedAtMs: number;
  readonly pausedOffsetMs: number;
  readonly pausedSinceMs: number | null;
  readonly buffer: readonly BufferedInput[];
}

/**
 * 権威ループのコーディネータ。1 マッチ = 1 インスタンス(DO が保持)。
 * 副作用(時刻・WebSocket 送信・setInterval)は持たず、すべて呼び出し側が注入する。
 */
export class MatchSession {
  private readonly engine: MatchEngine;
  private readonly ids: readonly [string, string];
  /**
   * 制限時間(ミリ秒)。config.options から取り込む(engine は private 保持のため)。
   * 終了専用 alarm の deadline 算出(ADR 0011 #10 / 0012)に使う。engine の timeLimitMs と
   * 同値(同じ config から構築するため)。
   */
  private readonly timeLimitMs: number;

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

  /**
   * 累積の一時停止時間(ミリ秒, ラグ補償 B3 / ADR 0011 #8/#11)。
   *
   * 切断猶予で試合を一時停止している間、権威時計を凍結するために導入する。authClock は
   * `nowMs - INPUT_DELAY_MS - pausedOffsetMs` で算出する。停止していた実時間ぶんを nowMs から
   * 差し引くことで「停止中は権威時刻が一切進まない」=制限時間・effect 失効・castTime・CD の
   * すべてが停止ぶんだけオフセットされる(ADR 0011 #11)。再開時に停止していた実時間を
   * ここへ加算する。決定論 replay でも atMs 自体がこのオフセット込みで確定するため再現する。
   */
  private pausedOffsetMs = 0;

  /**
   * 一時停止を開始した実時刻(wall nowMs)。停止中でなければ null。
   * 再開時にこことの差分を pausedOffsetMs へ加算して権威時計の凍結ぶんを確定する。
   */
  private pausedSinceMs: number | null = null;

  constructor(engine: MatchEngine, config: MatchConfig) {
    this.engine = engine;
    this.ids = [config.players[0].id, config.players[1].id];
    this.timeLimitMs = config.options?.timeLimitMs ?? MATCH_DEFAULT_TIME_LIMIT_MS;
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
   * 各コマンドの atMs を [lastConfirmedAtMs, wall] にクランプして権威 atMs を決め
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
    // 権威ウォール(停止ぶんを差し引いた現在時刻)を未来クランプの上限に使う。停止中の
    // 上限は停止開始時点で凍結する(停止中に届いた入力で未来時刻を稼げないようにする)。
    const wall = this.authWall(nowMs);
    for (const cmd of commands) {
      const atMs = this.clampAtMs(cmd.atMs, wall);
      // クランプ後の atMs を権威時刻として buffer へ積む(元 cmd の atMs は使わない)。
      this.buffer.push({ playerId, atMs, command: { ...cmd, atMs } });
    }
  }

  /**
   * クライアント主張 atMs を権威 atMs にクランプする(アンチチート, ADR 0011 #2)。
   * - 非有限は wall に倒す。
   * - 未来(権威ウォール wall より先)は wall に丸める(先の時刻を主張して deadline を飛び越え
   *   させない)。wall は停止ぶんを差し引いた現在時刻(authWall)で、停止中は凍結する。
   * - 既に確定した時刻(lastConfirmedAtMs より前)は lastConfirmedAtMs に丸める(遅すぎる
   *   入力のペナルティ。tick で既に authClock=T まで適用・確定済みなら、後から届いた T 未満の
   *   入力は T へ寄せて決定論を保つ。等号は許す)。
   * 巻き戻し不可。等号維持(同一 atMs はそのまま)なので相打ち draw 契約を壊さない。
   */
  private clampAtMs(claimedAtMs: number, wall: number): number {
    let atMs = Number.isFinite(claimedAtMs) ? claimedAtMs : wall;
    if (atMs > wall) {
      atMs = wall;
    }
    if (atMs < this.lastConfirmedAtMs) {
      atMs = this.lastConfirmedAtMs; // 確定済みの過去へは戻せない(等号は維持)。
    }
    return atMs;
  }

  /**
   * 遅延権威クロックを nowMs - INPUT_DELAY_MS へ進め、揃ったバッファ入力を確定する
   * (ラグ補償, ADR 0011)。順序:
   *   ① authClock = clampMonotonic(authWall - INPUT_DELAY_MS)(startAtMs 未満にしない・
   *      lastConfirmedAtMs 以上へ単調)。
   *   ② buffer から atMs <= authClock を全取り出し、(atMs, playerId) 安定ソートして
   *      engine へ順に適用(selectCard / pressKey)。atMs > authClock は次 tick へ残す。
   *   ③ evaluateTimeUp(authClock)→ flush()。
   *   ④ lastConfirmedAtMs = authClock。
   * これで両者の atMs=T 入力は authClock が T を越える前にバッファへ揃い、ソートで隣接 →
   * 解決前に両方適用 = 厳密な同時撃破も draw(ADR 0010 #16)。終了したか(finished)を返す。
   *
   * 一時停止中(切断猶予, ADR 0011 #8/#11)は権威時計を凍結するため tick は何も進めない
   * (authClock を進めず・入力も確定せず・時間切れ判定もしない)。停止ぶんは resume で
   * pausedOffsetMs に畳み込まれ、再開後の authClock がその分だけ過去に留まる(deadline /
   * effect 失効 / CD / castTime のすべてがオフセットされる)。
   */
  tick(nowMs: number): boolean {
    if (!this.started || this.engine.finished || this.pausedSinceMs !== null) {
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

    // ③ 時間切れ評価 → flush。
    this.engine.evaluateTimeUp(authClock);
    this.engine.flush();

    // ④ 権威確定点を進める(次回 tick / クランプ / timers の基準)。
    this.lastConfirmedAtMs = authClock;
    return this.engine.finished;
  }

  /**
   * 権威ウォール時刻を算出する(停止ぶんを差し引いた現在時刻, ADR 0011 #11)。
   * = `nowMs - pausedOffsetMs`。停止中は停止開始時点(pausedSinceMs)で凍結する。
   * authClock(= authWall - INPUT_DELAY_MS)と未来クランプ上限の共通基準。
   */
  private authWall(nowMs: number): number {
    const wallNow = this.pausedSinceMs ?? nowMs;
    return wallNow - this.pausedOffsetMs;
  }

  /**
   * 遅延権威クロックを算出する(authWall - INPUT_DELAY_MS を単調・下限付きで丸める)。
   * - 停止ぶん(pausedOffsetMs)を差し引いた authWall 起点で算出する(権威時計の凍結, #11)。
   * - startAtMs 未満にはしない(開始前の deadline 計算 / 負経過を避ける)。
   * - lastConfirmedAtMs 以上へ単調(authClock は決して巻き戻さない)。
   */
  private authClockAt(nowMs: number): number {
    const lowerBound = this.startAtMs ?? 0;
    const raw = this.authWall(nowMs) - INPUT_DELAY_MS;
    return Math.max(this.lastConfirmedAtMs, lowerBound, raw);
  }

  /**
   * 試合を一時停止する(切断猶予, ADR 0011 #8/#11)。冪等。
   * 停止開始の実時刻を記録するだけで、権威時計は authWall/authClock が pausedSinceMs で
   * 凍結することで止まる。停止中は tick が一切進まない(deadline / effect 失効 / CD /
   * castTime が停止ぶんオフセットされる)。未開始・決着後は無視する。
   */
  pause(nowMs: number): void {
    if (!this.started || this.engine.finished || this.pausedSinceMs !== null) {
      return;
    }
    this.pausedSinceMs = nowMs;
  }

  /**
   * 一時停止を解除する(再接続, ADR 0011 #8/#11)。冪等。
   * 停止していた実時間(nowMs - pausedSinceMs)を pausedOffsetMs へ畳み込み、以後の authWall
   * がその分だけ過去に留まるようにする(凍結ぶんの権威時計を後ろへずらす)。これで停止中に
   * 自分の CD 回復や相手 haste の失効を稼ぐ悪用を防ぐ(ADR 0011 #11)。
   */
  resume(nowMs: number): void {
    if (this.pausedSinceMs === null) {
      return;
    }
    // 負の経過(時計巻き戻し)で停止ぶんが減らないよう下限 0。
    this.pausedOffsetMs += Math.max(0, nowMs - this.pausedSinceMs);
    this.pausedSinceMs = null;
  }

  /**
   * 指定プレイヤーの放棄(forfeit)で決着させる(切断猶予超過, ADR 0011 #8/#12)。
   * 権威時計(authClock)で engine.forfeit を呼び、相手の win・本人の lose に確定する。
   * 停止中でも放棄は確定させる(猶予超過の権威イベント)。決着後は engine 側で無視される。
   * 終了したか(finished)を返す。
   */
  forfeit(playerId: string, nowMs: number): boolean {
    if (!this.started || !this.isKnown(playerId)) {
      return this.engine.finished;
    }
    this.engine.forfeit(playerId, this.authClockAt(nowMs));
    return this.engine.finished;
  }

  /** 一時停止中か(切断猶予中, ADR 0011 #8/#11)。 */
  get paused(): boolean {
    return this.pausedSinceMs !== null;
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

  /**
   * 視点非依存の権威スナップショットシグネチャ(ADR 0012 のチェックポイント書き込み契機)。
   *
   * DO は 10Hz の全 tick で storage へ書くのを避け、「state が意味的に変わった tick(発動 / KO /
   * 効果適用でシグネチャが変化したとき)」にだけ checkpoint する。そのための差分検知に使う。
   * 両陣営の入力軸シグネチャ + outcome を畳む(時間軸 timers は毎 tick 動くため含めない)。
   * 順序契約: 直前に flush して保留中の KO を確定させてから読む。
   */
  stateSignature(): string {
    this.engine.flush();
    return signatureOf(this.engine.snapshot(this.ids[0]));
  }

  /**
   * 制限時間切れの権威 deadline を「壁時計(実時間)」へ換算して返す(ADR 0012 の alarm 用)。
   *
   * 権威 deadline(auth 時間)= `startAtMs + timeLimitMs`。authClock がこの値へ到達するのは
   * `authWall(now) - INPUT_DELAY_MS >= deadline`、すなわち
   *   `wallNow >= deadline + INPUT_DELAY_MS + pausedOffsetMs`
   * のとき(authWall = wallNow - pausedOffsetMs)。この右辺を返す。
   *
   * 一時停止中(凍結)は authClock が進まないため deadline は到来しない → null を返す
   * (alarm 側は停止中は猶予 deadline だけを予約する。凍結中に旧 deadline で誤発火しないため)。
   * 未開始・決着後も null(予約不要)。
   */
  timeLimitDeadlineWallMs(): number | null {
    if (!this.started || this.startAtMs === null || this.engine.finished || this.paused) {
      return null;
    }
    const authDeadline = this.startAtMs + this.timeLimitMs;
    return authDeadline + INPUT_DELAY_MS + this.pausedOffsetMs;
  }

  /**
   * session の権威クロック状態を直列化する(ADR 0012)。engine の状態は別途
   * `MatchEngine.serialize()` が持つため、ここは session 固有の時計・バッファだけを出す。
   */
  serialize(): MatchSessionDTO {
    return {
      started: this.started,
      startAtMs: this.startAtMs,
      lastConfirmedAtMs: this.lastConfirmedAtMs,
      pausedOffsetMs: this.pausedOffsetMs,
      pausedSinceMs: this.pausedSinceMs,
      buffer: this.buffer.map((b) => ({ ...b })),
    };
  }

  /**
   * 直列化状態から MatchSession を復元する静的ファクトリ(ADR 0012)。
   * 復元済み engine(`MatchEngine.restore`)と同一 config から新規 session を作り、DTO の
   * 権威クロック(started/startAtMs/lastConfirmedAtMs/pausedOffset/pausedSince)と未確定の
   * 入力バッファを上書きする。これで DO 退避・再起動後も authClock / クランプ基準 / 凍結が
   * 一致し、中断なしと同一に続行できる(決定論)。lastSignature は揮発(復元後の最初の
   * snapshot/delta で配り直す)。
   */
  static restore(engine: MatchEngine, config: MatchConfig, dto: MatchSessionDTO): MatchSession {
    const session = new MatchSession(engine, config);
    session.started = dto.started;
    session.startAtMs = dto.startAtMs;
    session.lastConfirmedAtMs = dto.lastConfirmedAtMs;
    session.pausedOffsetMs = dto.pausedOffsetMs;
    session.pausedSinceMs = dto.pausedSinceMs;
    session.buffer = dto.buffer.map((b) => ({ ...b }));
    return session;
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
