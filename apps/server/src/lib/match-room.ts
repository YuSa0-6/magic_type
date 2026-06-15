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
 *  - **打鍵の処理はまだしない(B2)。**
 *
 * B1 はハイバネーション無しでマッチ中メモリ常駐させる(標準 WebSocket API: `accept()` +
 * `addEventListener`)。
 *
 * ── B2 で守る契約(ここに残す)──────────────────────────────────────────────
 *  打鍵の権威適用と snapshot 読み取りの順序契約: ある atMs/tick に属する両陣営の全
 *  コマンドを MatchEngine へ適用しきってから snapshot / 結果を読むこと。途中で読むと、
 *  同一 atMs に両者が相手を 0 にした相打ち(draw, ADR 0010 #16)が、先に適用した側の
 *  KO だけ見えて片側 win に化ける。MatchEngine は pendingKoAtMs により「同一 atMs の全
 *  発動を適用しきった後に一括評価」する遅延評価で相打ちを draw に裁定する(match.ts)。
 *  したがって B2 の 10Hz デルタ push / 終了 alarm は、当該 tick のコマンドを全適用後に
 *  engine.flush() してから snapshot を取ること。さもなくば draw が片側 win に化ける。
 * ───────────────────────────────────────────────────────────────────────────
 */

import {
  createRoom,
  join,
  markReady,
  parseClientMessage,
  roleOf,
  submitDeck,
  tryStart,
  type ClientMessage,
  type RoomState,
  type ServerMessage,
  type SlotRole,
} from '../domain/match/index.ts';
import { MatchEngine } from '../domain/engine/index.ts';

/** DO が参照する環境バインディング(B1 では未使用だが型として用意)。 */
export interface Env {
  readonly MATCH_ROOM: DurableObjectNamespace;
}

/** 1 接続の管理単位。エフェメラル ID で席へ紐づく。 */
interface Connection {
  readonly socket: WebSocket;
  readonly ephemeralId: string;
  /** 着席後に確定する role。未着席は null。 */
  role: SlotRole | null;
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
    const conn: Connection = { socket: server, ephemeralId, role: null };
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
        this.handleJoin(conn);
        break;
      case 'submitDeck':
        this.handleSubmitDeck(conn, msg.deckIds);
        break;
      case 'ready':
        this.handleReady(conn);
        break;
    }
  }

  /** join: 空席へ着席して role を返す。満室/開始済みはエラー。 */
  private handleJoin(conn: Connection): void {
    if (conn.role !== null) {
      // 二重 join は冪等に再通知する。
      this.send(conn, { type: 'joined', ephemeralId: conn.ephemeralId, role: conn.role });
      return;
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
    this.room = result.value.state;
    this.send(conn, { type: 'joined', ephemeralId: conn.ephemeralId, role: conn.role });
    // 相手(他席)へ参加を通知する。
    this.broadcastExcept(conn.ephemeralId, { type: 'opponentJoined' });
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
    const result = tryStart(this.room, { masterSeed });
    if (!result.ok) {
      // not_ready: まだ片方だけ。何もせず相手の ready を待つ。
      return;
    }
    this.room = result.value.state;
    const { config, playerIds } = result.value;

    // 権威エンジンを DO 内に生成して保持する(B2 の打鍵権威ループで使う)。
    // B1 では生成のみで打鍵処理はしない。
    this.engine = new MatchEngine(config.players, config.options);

    // 両者へ matchStart(seed + self/opponent の id)を配る(ADR 0011 #7)。
    for (const conn of this.connections.values()) {
      if (conn.role === null) {
        continue;
      }
      const selfId = playerIds[conn.role];
      const opponentId = playerIds[conn.role === 0 ? 1 : 0];
      this.send(conn, { type: 'matchStart', seed: masterSeed, selfId, opponentId });
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

  /** 切断処理。接続を外す。B1 は再接続猶予(B3)を扱わない。 */
  private onClose(conn: Connection): void {
    this.connections.delete(conn.ephemeralId);
    // B3(再接続猶予・放棄負け)は範囲外。ここでは席は解放しない(マッチ開始前の
    // 単純な切断のみ想定)。再接続/猶予の権威状態凍結は ADR 0011 #8/#11 で後続実装。
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
   * B1 では生成・保持のみ。B2 の打鍵権威ループがここを駆動する。
   */
  get matchEngine(): MatchEngine | null {
    return this.engine;
  }
}
