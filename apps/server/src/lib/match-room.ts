/**
 * Durable Object `MatchRoom`(ADR 0011 #5: 1 マッチ = 1 DO)。
 *
 * domain の `RoomState`(純 TS)を保持し、WebSocket 接続を受ける薄いランタイムラッパー
 * (ADR 0004 の lib 層)。判定・ルール・MatchConfig 組み立てはすべて domain と engine に
 * 委譲し、ここは「接続を受ける / メッセージを domain へ橋渡しする / 副作用(エフェメラル ID
 * 発行・masterSeed 生成・WS 送信)を注入する」だけに徹する。
 *
 * B1 の範囲:
 *  - 接続時に `crypto.randomUUID()` でエフェメラル ID を発行(ADR 0011 #7)。
 *  - join → submitDeck(サーバー検証)→ ready を処理。
 *  - 両者 ready で `tryStart` → masterSeed を `crypto.getRandomValues` で生成し(乱数源は
 *    domain の外, ADR 0011 #7/#13)、domain に渡して MatchConfig を構築。
 *  - `new MatchEngine(config.players, config.options)` を DO 内に生成して保持する
 *    (B2 の打鍵権威ループで使う)。両者へ matchStart を送る。
 *
 * B1 はハイバネーション無しでマッチ中メモリ常駐させる(標準 WebSocket API: `accept()` +
 * `addEventListener`)。
 *
 * ── B2 の実装(遅延権威シミュレーションを MatchSession へ集約, ADR 0011 ラグ補償)──
 *  打鍵の権威確定は「遅延権威クロック(authClock = nowMs - INPUT_DELAY_MS)」でのみ起きる。
 *  input 到着順に即適用すると、片側のバッチが KO 後の後続 atMs を含むだけで MatchEngine の
 *  auto-flush(pendingKoAtMs)が走り、まだ届いていない相手の同一 atMs 入力より先に win が
 *  確定して相打ち draw(ADR 0010 #16)が片側 win に化ける。これを根本修正する。
 *
 *  この遅延 sim は domain の `MatchSession`(純 TS, テスト対象)に集約した:
 *   - input 受信は `session.enqueueInput()` でバッファへ積むだけ(engine を一切呼ばない)。
 *   - 約 100ms の時間 tick で `session.tick()`: authClock 以下の両者入力を (atMs, playerId)
 *     ソートして engine へ適用 → 両陣営 drain → 時間切れ判定 → flush。INPUT_DELAY ぶん
 *     遅らせることで同一 atMs の両者入力が解決前に必ず揃い、ソートで隣接 → 相打ち draw を守る。
 *   - push は tick 側で flush 後に行い、下りを 10Hz に揃える。
 *
 *  push 方式 = setInterval(約 100ms = 10Hz, ADR 0008 の表示解像度)。終了専用 alarm でも
 *  良いが(ADR 0011 #10)、B1 が非ハイバネーションでマッチ中メモリ常駐するため、表示用
 *  tick と終了の権威判定(evaluateTimeUp)を同じ setInterval に相乗りできる。終了(finished)
 *  を tick 内で検知したら matchEnd を送って interval を止める(終了判定の権威 = サーバー)。
 *  終了 tick は通常デルタ push をスキップし、最終 state は matchEnd 側に一本化する(二重 push
 *  解消)。代償として権威確定が INPUT_DELAY 遅れるが、自陣はローカル予測(B3)で体感ゼロ。
 *
 * ── B3 の実装(切断猶予つき再接続 + 権威時計凍結, ADR 0011 #8/#11)──────────────
 *  進行中に着席プレイヤーが切断したら、即終了させず権威時計を凍結(session.pause)して
 *  RECONNECT_GRACE_MS のあいだ再接続を待つ。凍結中は tick が一切進まないため、制限時間・
 *  effect 失効・CD・castTime が停止ぶんオフセットされる(#11)。猶予超過は切断側の forfeit
 *  負け(#8/#12)。再接続は join.resumeId(= 元の席のエフェメラル ID)で同じ席へ復帰し、
 *  matchResumed(seed/self/opponent)+ 現況 state で表示を回復させる。相手へは
 *  opponentConnection(paused) で切断/再開を通知する。serialize/restore(A3)は単一 DO が
 *  メモリ常駐で権威状態を保持するため B3 では使わない(将来 DO 退避が必要になれば使う)。
 * ───────────────────────────────────────────────────────────────────────────
 */

import {
  createRoom,
  join,
  markReady,
  MatchSession,
  parseClientMessage,
  roleOf,
  submitDeck,
  tryStart,
  type ClientMessage,
  type InputCommand,
  type RoomState,
  type ServerMessage,
  type ServerOutcome,
  type SlotRole,
} from '../domain/match/index.ts';
import { MatchEngine, type MatchConfig, type MatchOutcome } from '../domain/engine/index.ts';

/** 約 10Hz(ADR 0008 の表示解像度)= 100ms 周期で権威 tick + デルタ push する。 */
const TICK_INTERVAL_MS = 100;

/**
 * 切断後に席を保持して再接続を待つ猶予(ミリ秒, ADR 0011 #8)。
 * この間は権威時計を凍結(session.pause)し、超過したら切断側の放棄負け(forfeit)にする。
 */
const RECONNECT_GRACE_MS = 30_000;

/** DO が参照する環境バインディング(B1 では未使用だが型として用意)。 */
export interface Env {
  readonly MATCH_ROOM: DurableObjectNamespace;
}

/** 1 接続の管理単位。エフェメラル ID で席へ紐づく。 */
interface Connection {
  readonly socket: WebSocket;
  /** この WS 接続の識別子(接続時に発行)。connections マップのキー。 */
  readonly ephemeralId: string;
  /**
   * 着席後に確定する role。未着席は null。
   * 再接続(B3, ADR 0011 #8)では、新しい WS 接続でも既存の席(role)へ復帰する。
   */
  role: SlotRole | null;
  /**
   * 権威エンジン上の playerId(席のエフェメラル ID)。新規着席では ephemeralId と一致するが、
   * 再接続では「元の席 id」になる(engine の playerId は matchStart 時に固定されるため)。
   * 入力の権威適用・snapshot 視点解決はこの seatId を使う。未着席は null。
   */
  seatId: string | null;
}

export class MatchRoom implements DurableObject {
  private room: RoomState;
  /** 接続中の WebSocket(エフェメラル ID → 接続)。B1 はメモリ常駐(ハイバネーション無し)。 */
  private readonly connections = new Map<string, Connection>();
  /**
   * マッチ開始時に生成する権威エンジン(B2 の打鍵権威ループで使うため保持)。
   * 開始前は null。
   */
  private engine: MatchEngine | null = null;
  /**
   * 権威ループのコーディネータ(順序契約・アンチチート・デルタ判定を集約, B2)。
   * マッチ開始時に engine と対で生成し、tick/input をここへ委譲する。開始前は null。
   */
  private session: MatchSession | null = null;
  /** role(0/1)→ そのプレイヤーのエフェメラル ID。snapshot 視点解決に使う。 */
  private playerIds: readonly [string, string] | null = null;
  /** 権威マスター seed(matchStart で生成して保持。再接続時の matchResumed で再配布する)。 */
  private masterSeed = 0;
  /** 約 100ms の権威 tick(setInterval)。終了で停止し null に戻す(非ハイバネーション常駐)。 */
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /** matchEnd を二重送信しないためのガード。 */
  private ended = false;
  /**
   * 切断猶予タイマ(role → setTimeout ハンドル, ADR 0011 #8)。席が切断されたとき起動し、
   * RECONNECT_GRACE_MS 以内に再接続が無ければその席の forfeit を確定する。再接続でクリアする。
   */
  private graceTimers: [
    ReturnType<typeof setTimeout> | null,
    ReturnType<typeof setTimeout> | null,
  ] = [null, null];

  constructor(ctx: DurableObjectState, _env: Env) {
    // DO の id 文字列をルームコード代わりに使う(ルーティングは routes が code → idFromName)。
    this.room = createRoom(ctx.id.toString());
  }

  /**
   * WebSocket アップグレードを受ける。Hono(routes)が `Upgrade: websocket` 付きで
   * このオブジェクトへ fetch をフォワードする。
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // B1 はハイバネーション無しでマッチ中メモリ常駐する(標準 WS API)。
    server.accept();

    // 接続時にエフェメラル ID を発行する(ADR 0011 #7)。
    const ephemeralId = crypto.randomUUID();
    const conn: Connection = { socket: server, ephemeralId, role: null, seatId: null };
    this.connections.set(ephemeralId, conn);

    server.addEventListener('message', (event) => {
      this.onMessage(conn, event.data);
    });
    const cleanup = () => this.onClose(conn);
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** 1 メッセージを domain へ橋渡しする。不正 JSON / 未知 type はエラーを返す。 */
  private onMessage(conn: Connection, data: string | ArrayBuffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      this.send(conn, { type: 'error', message: '不正なメッセージ形式です' });
      return;
    }
    const msg = parseClientMessage(parsed);
    if (msg === null) {
      this.send(conn, { type: 'error', message: '未知のメッセージです' });
      return;
    }
    this.dispatch(conn, msg);
  }

  private dispatch(conn: Connection, msg: ClientMessage): void {
    switch (msg.type) {
      case 'join':
        this.handleJoin(conn, msg.resumeId);
        break;
      case 'submitDeck':
        this.handleSubmitDeck(conn, msg.deckIds);
        break;
      case 'ready':
        this.handleReady(conn);
        break;
      case 'input':
        this.handleInput(conn, msg.commands);
        break;
    }
  }

  /**
   * input(打鍵ストリーム, B2): 着席済み・開始済みなら session のバッファへ積むだけ。
   * 実適用・KO 評価・push は時間 tick の遅延権威クロックで行う(ラグ補償, ADR 0011)。
   * 同一 atMs の両者入力の取りこぼし(相打ち draw の喪失)を防ぐ。
   * 終了後入力ゲートを層で揃える: ここで ended を先に弾き(DO 層)、session も
   * engine.finished で弾く(domain 層)。未着席・未開始も無視する。
   */
  private handleInput(conn: Connection, commands: readonly InputCommand[]): void {
    if (this.ended || conn.seatId === null || this.session === null) {
      return;
    }
    // 権威適用は席 id(engine の playerId)で行う。再接続で WS の ephemeralId が変わっても
    // seatId は元の席に固定されるため、入力は正しい陣営へ積まれる(ADR 0011 #8)。
    // atMs はサーバー受信時刻でクランプ・単調化する(アンチチート, ADR 0011 #2)。
    this.session.enqueueInput(conn.seatId, commands, Date.now());
  }

  /**
   * join: 空席へ着席して role を返す。満室/開始済みはエラー。
   * 再接続(B3, ADR 0011 #8): resumeId が開始済みマッチの席に一致すれば、その席へ復帰する
   * (満室・開始済みでも入室可)。それ以外は通常の新規着席(満室/開始済みは弾く)。
   */
  private handleJoin(conn: Connection, resumeId?: string): void {
    if (conn.role !== null) {
      // 二重 join は冪等に再通知する。
      this.send(conn, { type: 'joined', ephemeralId: conn.ephemeralId, role: conn.role });
      return;
    }
    // 再接続: 開始済みマッチで、resumeId が在席の席 id に一致するなら席へ復帰する。
    if (this.session !== null && resumeId !== undefined) {
      const role = roleOf(this.room, resumeId);
      if (role !== null) {
        this.handleReconnect(conn, role, resumeId);
        return;
      }
    }
    const result = join(this.room, conn.ephemeralId);
    if (!result.ok) {
      const message =
        result.error === 'room_full' ? 'ルームが満室です' : 'マッチは既に開始しています';
      this.send(conn, { type: 'error', message });
      // 着席できない接続は閉じる(満室への 3 人目は入室不可)。
      conn.socket.close(1008, message);
      this.connections.delete(conn.ephemeralId);
      return;
    }
    conn.role = result.value.role;
    // 新規着席では席 id = この接続の ephemeralId(engine の playerId になる)。
    conn.seatId = conn.ephemeralId;
    this.room = result.value.state;
    this.send(conn, { type: 'joined', ephemeralId: conn.ephemeralId, role: conn.role });
    // 相手(他席)へ参加を通知する。
    this.broadcastExcept(conn.ephemeralId, { type: 'opponentJoined' });
  }

  /**
   * 再接続で席へ復帰する(B3, ADR 0011 #8)。新しい WS 接続を元の席(role / seatId)へ束ね、
   * 同席の古い接続があれば閉じて差し替える。猶予タイマをクリアし、相手の切断で一時停止して
   * いた権威時計を再開(session.resume)する。復帰側へ matchResumed(seed/self/opponent)+
   * 現況 state を配り、相手へは opponentConnection(paused=false)を通知する。
   */
  private handleReconnect(conn: Connection, role: SlotRole, seatId: string): void {
    if (this.session === null || this.playerIds === null) {
      return;
    }
    // 同席の古い接続(切断検知前に残骸が残っている場合)を閉じて置き換える。
    for (const other of this.connections.values()) {
      if (other !== conn && other.role === role) {
        other.role = null;
        try {
          other.socket.close(1000, 'replaced by reconnect');
        } catch {
          // 既に閉じている等は無視。
        }
        this.connections.delete(other.ephemeralId);
      }
    }
    conn.role = role;
    conn.seatId = seatId;

    // 猶予タイマをクリアし、権威時計を再開する(凍結ぶんは resume でオフセット, #11)。
    this.clearGraceTimer(role);
    this.session.resume(Date.now());

    // 復帰側へ初期化情報(seed/self/opponent)+ 現況 state を配って表示を回復させる。
    const selfId = this.playerIds[role];
    const opponentId = this.playerIds[role === 0 ? 1 : 0];
    this.send(conn, { type: 'matchResumed', seed: this.masterSeed, selfId, opponentId });
    this.send(conn, { type: 'state', payload: this.session.snapshotFor(selfId, Date.now()) });

    // 相手へ「相手が再接続して再開した」を通知する(表示用)。
    this.broadcastExcept(conn.ephemeralId, { type: 'opponentConnection', paused: false });

    // 凍結を解除したので権威 tick を再開する(決着済みでなければ)。
    if (!this.ended) {
      this.startTickLoop();
    }
  }

  /** submitDeck: サーバー検証して席へ記録する。不正は理由付きエラー。 */
  private handleSubmitDeck(conn: Connection, deckIds: readonly string[]): void {
    const result = submitDeck(this.room, conn.ephemeralId, deckIds);
    if (!result.ok) {
      const e = result.error;
      const message =
        e.kind === 'invalid_deck'
          ? `デッキが不正です: ${e.errors.join(' / ')}`
          : e.kind === 'unknown_player'
            ? 'まだ参加していません'
            : 'マッチは既に開始しています';
      this.send(conn, { type: 'error', message });
      return;
    }
    this.room = result.value;
    this.send(conn, { type: 'deckAccepted' });
  }

  /** ready: 表明後、両者 ready なら tryStart → matchStart 配信。 */
  private handleReady(conn: Connection): void {
    const result = markReady(this.room, conn.ephemeralId);
    if (!result.ok) {
      const message =
        result.error === 'no_deck'
          ? 'デッキを提出してください'
          : result.error === 'unknown_player'
            ? 'まだ参加していません'
            : 'マッチは既に開始しています';
      this.send(conn, { type: 'error', message });
      return;
    }
    this.room = result.value;
    this.maybeStart();
  }

  /** 両者 ready かつ両デッキ合法ならマッチを開始する。 */
  private maybeStart(): void {
    // masterSeed の生成は domain の外(乱数源, ADR 0011 #7/#13)。crypto で 32bit を作る。
    const masterSeed = this.generateMasterSeed();
    this.masterSeed = masterSeed; // 再接続時の matchResumed 再配布のため保持。
    const result = tryStart(this.room, { masterSeed });
    if (!result.ok) {
      // not_ready: まだ片方だけ。何もせず相手の ready を待つ。
      return;
    }
    this.room = result.value.state;
    const { config, playerIds } = result.value;

    // 権威エンジン + コーディネータを DO 内に生成して保持する(B2 の打鍵権威ループ)。
    this.engine = new MatchEngine(config.players, config.options);
    const matchConfig: MatchConfig = { players: config.players, options: config.options };
    this.session = new MatchSession(this.engine, matchConfig);
    this.playerIds = playerIds;

    // 両者へ matchStart(seed + self/opponent の id)を配る(ADR 0011 #7)。
    for (const conn of this.connections.values()) {
      if (conn.role === null) {
        continue;
      }
      const selfId = playerIds[conn.role];
      const opponentId = playerIds[conn.role === 0 ? 1 : 0];
      this.send(conn, { type: 'matchStart', seed: masterSeed, selfId, opponentId });
    }

    // 権威時計を開始し、約 10Hz の権威 tick(drain → 時間切れ判定 → デルタ push)を回す。
    // 終了判定の権威 = サーバー。B1 が非ハイバネーション常駐のため setInterval で足りる
    // (終了専用 alarm でも可だが、表示 tick と相乗りできる, ADR 0008/0011 #10)。
    this.session.start(Date.now());
    this.startTickLoop();
  }

  /**
   * 約 100ms(10Hz)の権威 tick ループを開始する(ADR 0008/0011 #10)。
   * 各 tick で `session.tick`(両陣営 drain → 時間切れ判定 → flush)→ 両者へデルタ push。
   * 終了(finished)を検知したら matchEnd を送って interval を止める(終了判定の権威)。
   */
  private startTickLoop(): void {
    if (this.tickHandle !== null) {
      return;
    }
    this.tickHandle = setInterval(() => this.onTick(), TICK_INTERVAL_MS);
  }

  /**
   * 1 権威 tick。順序契約: tick(揃った入力をソート適用 + 全 drain + 時間切れ + flush)後に
   * デルタ push。終了 tick は通常 push をスキップし、endMatch の最終 snapshot に一本化する
   * (同一 tick の state 二重 push を解消, 監査 nit)。一時停止中(切断猶予)は session.tick が
   * 何も進めないため、通常デルタも実質止まる(凍結, ADR 0011 #11)。
   */
  private onTick(): void {
    if (this.session === null || this.playerIds === null) {
      return;
    }
    const now = Date.now();
    const finished = this.session.tick(now);
    if (finished) {
      // 終了 tick は通常デルタを送らず、endMatch が最終 state(+ matchEnd)を 1 度だけ送る。
      this.endMatch(now);
      return;
    }
    // tick の確定後に各視点のデルタを push する(順序契約: 読みは flush 後, ADR 0010 #14)。
    this.pushDeltas(now);
  }

  /** 両者へ視点別の state デルタを push する(変化が無い視点は送らない, 10Hz)。 */
  private pushDeltas(atMs: number): void {
    if (this.session === null || this.playerIds === null) {
      return;
    }
    for (const conn of this.connections.values()) {
      if (conn.role === null) {
        continue;
      }
      const playerId = this.playerIds[conn.role];
      const delta = this.session.deltaFor(playerId, atMs);
      if (delta !== null) {
        this.send(conn, { type: 'state', payload: delta });
      }
    }
  }

  /**
   * マッチ終了処理(終了判定の権威 = サーバー, ADR 0011 #10/#12)。
   * interval を止め、両者へ最終 state + matchEnd(視点別 outcome + 権威 result)を送る。
   * 二重送信は ended ガードで防ぐ。
   */
  private endMatch(atMs: number): void {
    if (this.ended || this.session === null || this.playerIds === null) {
      return;
    }
    this.ended = true;
    this.stopTickLoop();
    // 決着したら残っている猶予タイマも止める(KO/時間切れ後に forfeit が誤発火しないように)。
    this.clearGraceTimer(0);
    this.clearGraceTimer(1);
    const result = this.session.result;
    if (result === null) {
      return;
    }
    for (const conn of this.connections.values()) {
      if (conn.role === null) {
        continue;
      }
      const playerId = this.playerIds[conn.role];
      // 終了時は変化が無くても最終状態を確実に届ける(snapshotFor はデルタ判定なし)。
      const payload = this.session.snapshotFor(playerId, atMs);
      this.send(conn, { type: 'state', payload });
      this.send(conn, {
        type: 'matchEnd',
        outcome: toServerOutcome(payload.outcome),
        result: { winnerId: result.winnerId, endReason: result.endReason },
      });
    }
  }

  /** 権威 tick ループを止める(終了・接続消失時)。 */
  private stopTickLoop(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * 権威マスター seed を生成する(乱数源, ADR 0011 #7/#13)。domain は受け取った seed を
   * config へ詰めるだけ。ここで crypto.getRandomValues から 32bit 符号付き整数を作る。
   */
  private generateMasterSeed(): number {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] | 0;
  }

  /**
   * 切断処理(B3 再接続猶予, ADR 0011 #8/#11)。
   *
   * - マッチ開始前 / 決着後の切断: 接続を外すだけ(席は room の遷移に任せる)。全接続が消えたら
   *   孤立した tick を止める(空回り防止)。
   * - マッチ進行中に着席プレイヤーが切断: 即終了させず、権威時計を凍結(session.pause)して
   *   猶予 RECONNECT_GRACE_MS のあいだ再接続を待つ。凍結中は tick が一切進まないため、制限時間・
   *   effect 失効・CD・castTime が停止ぶんオフセットされる(凍結中の悪用防止, #11)。猶予超過で
   *   切断側の forfeit を確定する。相手へは opponentConnection(paused=true)を通知する。
   *
   * onClose は close/error の両方から呼ばれ得るので、既に席を外した接続は冪等に無視する。
   */
  private onClose(conn: Connection): void {
    this.connections.delete(conn.ephemeralId);
    const role = conn.role;
    // 進行中(session あり・未決着・着席中)の切断は猶予つき一時停止に入る。
    if (role !== null && this.session !== null && !this.ended) {
      this.pauseForReconnect(role);
      return;
    }
    // 開始前 / 決着後 / 未着席: 全接続が消えたら孤立 tick を止める(空回り防止)。
    if (this.connections.size === 0) {
      this.stopTickLoop();
    }
  }

  /**
   * 進行中の席切断で権威時計を凍結し、再接続猶予タイマを起動する(B3, ADR 0011 #8/#11)。
   * 既にその席の猶予タイマが走っていれば二重起動しない(冪等)。相手へ切断を通知する。
   */
  private pauseForReconnect(role: SlotRole): void {
    if (this.session === null || this.graceTimers[role] !== null) {
      return;
    }
    // 権威時計を凍結する(以後 tick は進まない, #11)。
    this.session.pause(Date.now());
    // 相手へ「相手が切断して一時停止中」を通知する(表示用)。
    this.broadcastToRole(role === 0 ? 1 : 0, { type: 'opponentConnection', paused: true });
    // 猶予超過で切断側の放棄負けを確定する。
    this.graceTimers[role] = setTimeout(() => {
      this.graceTimers[role] = null;
      this.forfeitSeat(role);
    }, RECONNECT_GRACE_MS);
  }

  /**
   * 切断猶予を超過した席を放棄負け(forfeit)で決着させる(B3, ADR 0011 #8/#12)。
   * 凍結中の権威時計で engine.forfeit を呼び(相手の win)、endMatch で matchEnd を配る。
   */
  private forfeitSeat(role: SlotRole): void {
    if (this.session === null || this.playerIds === null || this.ended) {
      return;
    }
    const now = Date.now();
    const finished = this.session.forfeit(this.playerIds[role], now);
    if (finished) {
      this.endMatch(now);
    }
  }

  /** 指定 role の猶予タイマがあれば止めてクリアする(再接続・終了時)。 */
  private clearGraceTimer(role: SlotRole): void {
    const handle = this.graceTimers[role];
    if (handle !== null) {
      clearTimeout(handle);
      this.graceTimers[role] = null;
    }
  }

  /** 1 接続へ JSON メッセージを送る。閉じた接続は無視する。 */
  private send(conn: Connection, msg: ServerMessage): void {
    try {
      conn.socket.send(JSON.stringify(msg));
    } catch {
      // 既に閉じている等。B1 では無視。
    }
  }

  /** 指定 ID 以外の全接続へ送る(相手通知用)。 */
  private broadcastExcept(exceptId: string, msg: ServerMessage): void {
    for (const conn of this.connections.values()) {
      if (conn.ephemeralId !== exceptId && conn.role !== null) {
        this.send(conn, msg);
      }
    }
  }

  /** 指定 role の(在席している)接続へ送る(切断/再接続の相手通知用, B3)。 */
  private broadcastToRole(role: SlotRole, msg: ServerMessage): void {
    for (const conn of this.connections.values()) {
      if (conn.role === role) {
        this.send(conn, msg);
      }
    }
  }

  /** テスト用: 現在のルーム状態を読む(読み取り専用)。 */
  get state(): RoomState {
    return this.room;
  }

  /** roleOf を domain から再公開(テスト/将来用)。 */
  roleOf(ephemeralId: string): SlotRole | null {
    return roleOf(this.room, ephemeralId);
  }

  /**
   * マッチ開始後に生成された権威エンジン(開始前は null)。
   * B1 では生成・保持のみ。B2 の打鍵権威ループがこれを駆動する。
   */
  get matchEngine(): MatchEngine | null {
    return this.engine;
  }

  /** マッチ開始後の権威ループ・コーディネータ(開始前は null)。テスト/将来用。 */
  get matchSession(): MatchSession | null {
    return this.session;
  }
}

/** engine の視点別 MatchOutcome を matchEnd 用の ServerOutcome へ写す(決着後のみ呼ぶ)。 */
function toServerOutcome(outcome: MatchOutcome): ServerOutcome {
  // ongoing はここへ来ない(endMatch は finished 時のみ呼ぶ)が、型の網羅性のため lose へ倒す。
  return outcome.kind === 'ongoing' ? 'lose' : outcome.kind;
}
