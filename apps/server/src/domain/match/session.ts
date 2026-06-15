/**
 * 対戦の権威ループ・コーディネータ `MatchSession`(B2, ADR 0011 #1/#2/#10)。純 TS。
 *
 * `MatchEngine` を 1 つ保持し、クライアントの打鍵ストリームをサーバー権威で実行して
 * 状態デルタを両陣営へ push する土台になる。DO(lib)はこの純 TS を「メモリ常駐 +
 * setInterval(時間 tick)+ WebSocket 送信」で駆動するだけの薄い配線にする(ADR 0004)。
 *
 * ── 順序契約(最重要, B1 DO コメント / ADR 0010 #14 / 0011 #2)──────────────────
 *  ある atMs/tick に属する両陣営の全コマンド・全 drain を MatchEngine へ適用しきってから
 *  flush() し、その後に snapshot / result を読む。途中で読むと、同一 atMs に両者が相手を
 *  0 にした相打ち(draw, ADR 0010 #16)が先に適用した側の KO だけ見えて片側 win に化ける。
 *
 *  この契約を API 形状で守る:
 *   - applyInput(): engine へ流すだけ(snapshot/flush しない)。
 *   - tick(): 両陣営の drainTypeahead → evaluateTimeUp(時間軸の権威, ADR 0007/0008/0011 #10)。
 *     最後に flush() で同一 tick の保留 KO を一括確定する。途中 snapshot は取らない。
 *   - snapshotFor(): 読む直前に flush() してから snapshot/timers/outcome をまとめて返す。
 *  呼び出し側(DO)は「全 applyInput → tick → (push 直前に)snapshotFor」の順で駆動する。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * アンチチート初歩(ADR 0011 #2 / バランスレビュー):
 *  - atMs はサーバー受信時刻(nowMs)でクランプし、過去/未来の自己申告を是正する。
 *  - 単調性: 各陣営の atMs は直前の受理 atMs 以上へクランプ(時間を巻き戻させない)。
 *  - 未着席 / 未開始 / 終了後の入力は無視する。
 *  - 極端な kps の本格的な統計ベース検知は B3 以降。ここでは「クランプ + 単調化」までを
 *    土台とする。重要: 単調化は『直前 atMs 以上』へ丸めるだけで、同一 atMs はそのまま
 *    保つ。連続打鍵を最小間隔へ"広げる"と、同一 atMs に両者が相手を 0 にした相打ち
 *    (draw, ADR 0010 #16)が片側ずつ別 atMs にずれて draw が win に化けるため行わない。
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

/**
 * 権威ループのコーディネータ。1 マッチ = 1 インスタンス(DO が保持)。
 * 副作用(時刻・WebSocket 送信・setInterval)は持たず、すべて呼び出し側が注入する。
 */
export class MatchSession {
  private readonly engine: MatchEngine;
  private readonly ids: readonly [string, string];

  /** 開始済みか(start を 1 度だけ呼ぶためのフラグ)。 */
  private started = false;

  /** 各陣営で最後に受理した権威 atMs(単調化クランプの基準)。 */
  private readonly lastAtMs: Record<string, number> = {};

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
   */
  start(atMs: number): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.engine.start(atMs);
  }

  /**
   * クライアントの入力バッチを順に engine へ適用する(順序契約: ここでは読まない)。
   *
   * nowMs はサーバー受信時刻。各コマンドの atMs を [直前 atMs, nowMs] にクランプして
   * 権威 atMs を決める(アンチチート, ADR 0011 #2)。未開始・未知 id は無視する。
   * 終了後の入力は engine 内部の isResolved ガードが破棄する(ここでは flush しない)。
   */
  applyInput(playerId: string, commands: readonly InputCommand[], nowMs: number): void {
    if (!this.started || !this.isKnown(playerId)) {
      return;
    }
    // 順序契約(最重要): ここで engine.finished / snapshot を読まない。それらは
    // flushPendingKo() を呼ぶため、同一 atMs バッチの途中で読むと相手の入力を適用する前に
    // 片側 KO が確定し、相打ち draw が片側 win に化ける(ADR 0010 #14/#16)。終了後入力の
    // 破棄は engine 内部の isResolved ガード(flush しない)が担保するので、ここでは流すだけ。
    for (const cmd of commands) {
      const atMs = this.clampAtMs(playerId, cmd.atMs, nowMs);
      if (cmd.kind === 'select') {
        this.engine.selectCard(playerId, cmd.handIndex, atMs);
      } else {
        this.engine.pressKey(playerId, cmd.key, atMs);
      }
    }
  }

  /**
   * クライアント主張 atMs を権威 atMs にクランプする(アンチチート, ADR 0011 #2)。
   * - 未来(nowMs より先)は nowMs に丸める(先の時刻を主張して deadline を飛び越えさせない)。
   * - 過去(直前受理 atMs より前)は直前 atMs に丸める(時間を巻き戻させない=単調化)。
   *   等号は許す(同一 atMs はそのまま)ので、同一 atMs の相打ち draw 契約を壊さない。
   * 受理した atMs を lastAtMs に記録して次回の単調下限にする。
   */
  private clampAtMs(playerId: string, claimedAtMs: number, nowMs: number): number {
    const prev = this.lastAtMs[playerId] ?? 0;
    let atMs = Number.isFinite(claimedAtMs) ? claimedAtMs : nowMs;
    if (atMs > nowMs) {
      atMs = nowMs;
    }
    if (atMs < prev) {
      atMs = prev; // 単調化(巻き戻し不可。等号は維持)。
    }
    this.lastAtMs[playerId] = atMs;
    return atMs;
  }

  /**
   * 時間 tick(ADR 0007/0008/0011 #10)。両陣営の先行入力ドレイン → 時間切れ判定を行う。
   *
   * 順序契約: ① 両陣営 drainTypeahead(同一 tick の全 drain を適用)→ ② evaluateTimeUp →
   * ③ flush() で同一 tick の保留 KO を一括確定。ここでは snapshot を取らない(読むのは
   * push 直前の snapshotFor)。終了したか(finished)を返す。
   */
  tick(atMs: number): boolean {
    if (!this.started || this.engine.finished) {
      return this.engine.finished;
    }
    // 両陣営の先行入力を同一 tick 時刻でドレインする(片側 KO の早漏れを避けるため両方先に)。
    this.engine.drainTypeahead(this.ids[0], atMs);
    this.engine.drainTypeahead(this.ids[1], atMs);
    // 時間切れの権威判定(deadline 超過 tick で残 HP 多い側 win / 同値 draw)。
    this.engine.evaluateTimeUp(atMs);
    // 同一 tick の保留 KO を一括確定(相打ち draw を守る順序契約)。
    this.engine.flush();
    return this.engine.finished;
  }

  /**
   * 指定視点の push 用ペイロードを返す(順序契約: 直前に flush)。
   * snapshot(入力軸)+ timers(時間軸 atMs 依存)+ outcome をまとめる。
   */
  snapshotFor(playerId: string, atMs: number): StatePayload {
    this.engine.flush();
    const snap = this.engine.snapshot(playerId);
    const timers = this.engine.snapshotTimers(playerId, atMs);
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
   * これで相手の個別打鍵ではなく意味のある状態変化だけを 10Hz で送る(ADR 0011 #2)。
   */
  deltaFor(playerId: string, atMs: number): StatePayload | null {
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
      timers: this.engine.snapshotTimers(playerId, atMs),
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
