/**
 * オンライン対戦の WebSocket トランスポート(B3 web 配線, ADR 0011 #2/#5/#6/#8)。
 *
 * サーバー(apps/server の MatchRoom DO)へ繋ぎ、ルーム作成・参加・デッキ提出・ready・
 * 打鍵ストリーム送信(30〜50ms バッチ)を行い、サーバー権威の state / matchEnd / 切断通知を
 * Svelte5 runes(`$state`)で公開する非コンポーネントのドメイン隣接ロジック(ADR 0006)。
 * rAF は使わない(ADR 0008): 送信バッチも受信反映も setInterval / イベント駆動。
 *
 * 層の境界(ADR 0005): web は `@magic/server/engine` しか参照できないため、サーバーの
 * `domain/match/protocol` の型はここで同じ形に再定義する(契約の二重定義だが、engine 限定の
 * 公開境界を崩さないための意図的な選択)。InputCommand / StatePayload は engine snapshot 由来の
 * 型を組み合わせて表す。
 *
 * 時間軸(ADR 0011 #2): クライアントは打鍵ごとの atMs をサーバーと同じウォール時計
 * (`Date.now()`)で打つ。サーバーは受信時刻でクランプ・単調化するため、多少のクロックずれは
 * 吸収される。ローカル予測(match-prediction)も同じ `Date.now()` 軸で進めて整合させる。
 *
 * 再接続(ADR 0011 #8): 接続が切れたら、サーバー発行のエフェメラル ID を resumeId として
 * 自動再接続を試みる。開始済みマッチなら同じ席へ復帰し、matchResumed + 現況 state で表示を
 * 回復する。猶予(サーバー側 ~30s)を超えると forfeit の matchEnd が届く。
 */

import type { MatchSnapshot, MatchTimers, MatchOutcome } from '@magic/server/engine';

/** 1 入力コマンド(server protocol と同形, ADR 0011 #2)。 */
export type InputCommand =
  | { readonly kind: 'select'; readonly handIndex: number; readonly atMs: number }
  | { readonly kind: 'press'; readonly key: string; readonly atMs: number };

/** push の state ペイロード(server protocol / session の StatePayload と同形)。 */
export interface StatePayload {
  readonly self: MatchSnapshot['self'];
  readonly opponent: MatchSnapshot['opponent'];
  readonly timers: MatchTimers;
  readonly outcome: MatchOutcome;
}

/** matchEnd の視点別結果(server protocol の ServerOutcome と同形)。 */
export type ServerOutcome = 'win' | 'lose' | 'draw' | 'forfeit';

/** server → client メッセージ(server protocol の ServerMessage と同形)。 */
type ServerMessage =
  | { readonly type: 'joined'; readonly ephemeralId: string; readonly role: 0 | 1 }
  | { readonly type: 'opponentJoined' }
  | { readonly type: 'deckAccepted' }
  | {
      readonly type: 'matchStart';
      readonly seed: number;
      readonly selfId: string;
      readonly opponentId: string;
    }
  | { readonly type: 'state'; readonly payload: StatePayload }
  | {
      readonly type: 'matchEnd';
      readonly outcome: ServerOutcome;
      readonly result: { readonly winnerId: string | null; readonly endReason: string };
    }
  | {
      readonly type: 'matchResumed';
      readonly seed: number;
      readonly selfId: string;
      readonly opponentId: string;
    }
  | { readonly type: 'opponentConnection'; readonly paused: boolean }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'opponentRematchRequested' };

/** 接続/対戦のフェーズ(UI 出し分け用)。 */
export type TransportPhase =
  | 'idle' // 未接続
  | 'connecting' // WS 接続中
  | 'waiting' // 着席済み・相手待ち / デッキ提出・ready 待ち
  | 'matched' // matchStart 受領・対戦中
  | 'ended' // matchEnd 受領
  | 'error'; // 復帰不能なエラー

/** matchStart / matchResumed が運ぶ開始情報(seed + 視点 id)。 */
export interface MatchStartInfo {
  readonly seed: number;
  readonly selfId: string;
  readonly opponentId: string;
}

/** 上りバッチ間隔(ms)。ADR 0011 #2 の 30〜50ms フレーム。 */
const INPUT_BATCH_MS = 40;
/** 再接続の試行間隔(ms)と最大試行回数(サーバー猶予 ~30s 内に収める)。 */
const RECONNECT_INTERVAL_MS = 2000;
const RECONNECT_MAX_TRIES = 12;

/**
 * オンライン対戦トランスポート。1 マッチ = 1 インスタンス。
 * runes フィールドを直接読めるよう、Svelte コンポーネントからはこのインスタンスを参照する。
 */
export class MatchTransport {
  /** 接続/対戦フェーズ。 */
  phase = $state<TransportPhase>('idle');
  /** 現在のルームコード(作成 or 参加で確定)。 */
  code = $state<string | null>(null);
  /** サーバー発行の自分のエフェメラル ID(再接続の resumeId に使う)。 */
  ephemeralId = $state<string | null>(null);
  /** 着席した role(0=作成側 / 1=参加側)。 */
  role = $state<0 | 1 | null>(null);
  /** 相手が着席済みか(満室)。 */
  opponentPresent = $state(false);
  /** 自分のデッキがサーバー検証を通ったか。 */
  deckAccepted = $state(false);
  /** matchStart / matchResumed の開始情報(予測エンジン初期化に使う)。 */
  start = $state<MatchStartInfo | null>(null);
  /** 直近に受信した権威 state(self/opponent/timers/outcome)。 */
  authState = $state<StatePayload | null>(null);
  /** 決着結果(matchEnd)。視点別 outcome + 権威 result。 */
  ended = $state<{ outcome: ServerOutcome; winnerId: string | null; endReason: string } | null>(
    null
  );
  /** 相手が切断して一時停止中か(ADR 0011 #8/#11)。 */
  opponentPaused = $state(false);
  /** 自分の接続が切れて再接続を試行中か(ADR 0011 #8)。 */
  reconnecting = $state(false);
  /** 直近のエラーメッセージ(不正デッキ・満室等)。 */
  errorMessage = $state<string | null>(null);
  /** 自分が再戦に同意したか(決着後, ADR 0011 #17)。二重送信ガードにも使う。 */
  rematchSelfRequested = $state(false);
  /** 相手が再戦に同意したか(opponentRematchRequested 受信, ADR 0011 #17)。 */
  rematchOpponentRequested = $state(false);

  /** state / matchStart / matchResumed の購読フック(予測エンジンを駆動する Match 側が登録)。 */
  onMessage: ((msg: ServerMessage) => void) | null = null;

  private socket: WebSocket | null = null;
  /** 提出予定のデッキ(再接続前の初期化フローで再送するため保持)。 */
  private deckIds: readonly string[] | null = null;
  /** 上り入力バッチ(INPUT_BATCH_MS 周期でまとめて送る)。 */
  private pendingInput: InputCommand[] = [];
  private batchHandle: ReturnType<typeof setInterval> | null = null;
  /** 再接続試行回数。成功でリセット。 */
  private reconnectTries = 0;
  private reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  /** 明示クローズ(leave)したら再接続しないためのフラグ。 */
  private closedByUser = false;

  /**
   * 新しいルームを作成してコードを得る(POST /api/match)。
   * 取得したコードで connect() すれば作成側として着席できる。
   */
  async createRoom(): Promise<string> {
    const res = await fetch('/api/match', { method: 'POST' });
    if (!res.ok) {
      throw new Error(`ルーム作成に失敗しました (${res.status})`);
    }
    const body = (await res.json()) as { code: string };
    this.code = body.code;
    return body.code;
  }

  /**
   * ルームコードへ WS 接続して join → submitDeck → ready のハンドシェイクを始める。
   * deckIds はサーバー検証(15 枚・同種最大 2・実在)に渡す自分のデッキ。
   */
  connect(code: string, deckIds: readonly string[]): void {
    this.code = code.toUpperCase();
    this.deckIds = deckIds;
    this.closedByUser = false;
    this.reconnectTries = 0;
    this.openSocket();
  }

  /** 実際の WS を開く(初回 connect と再接続の共通経路)。 */
  private openSocket(): void {
    if (this.code === null) {
      return;
    }
    this.phase = this.start === null ? 'connecting' : this.phase;
    const url = wsUrl(this.code);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => this.onOpen());
    socket.addEventListener('message', (ev) => this.onSocketMessage(ev));
    socket.addEventListener('close', () => this.onSocketClose());
    socket.addEventListener('error', () => {
      // close も続けて飛ぶので、ここでは特別な処理はしない。
    });
  }

  /** 接続確立。join(初回は resumeId 無し / 再接続は resumeId 付き)→ デッキ提出 → ready。 */
  private onOpen(): void {
    // 再接続なら resumeId(前回のエフェメラル ID)を渡して同じ席へ復帰を試みる。
    const resumeId = this.start !== null ? (this.ephemeralId ?? undefined) : undefined;
    this.sendRaw({ type: 'join', code: this.code ?? undefined, resumeId });
    // 初回ハンドシェイク(まだ matchStart していない)はデッキ提出 + ready まで進める。
    // 再接続(start あり)では席復帰だけを待つ(matchResumed が来る)。
    if (this.start === null && this.deckIds !== null) {
      this.sendRaw({ type: 'submitDeck', deckIds: this.deckIds });
      this.sendRaw({ type: 'ready' });
    }
  }

  /** WS メッセージ受信。型を絞って runes 状態へ反映し、購読フックへも渡す。 */
  private onSocketMessage(ev: MessageEvent): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMessage;
    } catch {
      return;
    }
    this.handleMessage(msg);
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'joined':
        this.ephemeralId = msg.ephemeralId;
        this.role = msg.role;
        this.phase = 'waiting';
        break;
      case 'opponentJoined':
        this.opponentPresent = true;
        break;
      case 'deckAccepted':
        this.deckAccepted = true;
        break;
      case 'matchStart':
        // 再戦(#17)後の新マッチ用にフラグをリセットする(初回は元々 false/null で無害)。
        this.ended = null;
        this.rematchSelfRequested = false;
        this.rematchOpponentRequested = false;
        this.start = { seed: msg.seed, selfId: msg.selfId, opponentId: msg.opponentId };
        this.opponentPresent = true;
        this.phase = 'matched';
        this.startBatchLoop();
        break;
      case 'matchResumed':
        // 再接続で席復帰した。開始情報を更新し、再開状態へ戻す(続く state で表示回復)。
        this.start = { seed: msg.seed, selfId: msg.selfId, opponentId: msg.opponentId };
        this.reconnecting = false;
        this.reconnectTries = 0;
        this.phase = 'matched';
        this.startBatchLoop();
        break;
      case 'state':
        this.authState = msg.payload;
        if (msg.payload.outcome.kind !== 'ongoing') {
          this.phase = 'ended';
        }
        break;
      case 'matchEnd':
        this.ended = {
          outcome: msg.outcome,
          winnerId: msg.result.winnerId,
          endReason: msg.result.endReason,
        };
        this.phase = 'ended';
        this.stopBatchLoop();
        break;
      case 'opponentConnection':
        this.opponentPaused = msg.paused;
        break;
      case 'opponentRematchRequested':
        this.rematchOpponentRequested = true;
        break;
      case 'error':
        this.errorMessage = msg.message;
        // 開始前のエラー(不正デッキ・満室)はフェーズをエラーへ。対戦中は表示だけ。
        if (this.start === null) {
          this.phase = 'error';
        }
        break;
    }
    this.onMessage?.(msg);
  }

  /** WS クローズ。対戦中(start あり・未終了)なら再接続を試みる(ADR 0011 #8)。 */
  private onSocketClose(): void {
    this.socket = null;
    this.stopBatchLoop();
    if (this.closedByUser || this.phase === 'ended') {
      return;
    }
    if (this.start !== null) {
      // 対戦中の切断: 自動再接続(サーバー側は権威時計を凍結して猶予待ち)。
      this.scheduleReconnect();
    } else {
      // ハンドシェイク中の切断は復帰経路が無いのでエラーへ倒す。
      this.phase = 'error';
      this.errorMessage = this.errorMessage ?? 'サーバーとの接続が切れました';
    }
  }

  /** 再接続をスケジュールする(間隔つきリトライ、上限超過でエラー)。 */
  private scheduleReconnect(): void {
    if (this.reconnectHandle !== null) {
      return;
    }
    if (this.reconnectTries >= RECONNECT_MAX_TRIES) {
      this.reconnecting = false;
      this.phase = 'error';
      this.errorMessage = '再接続できませんでした(猶予時間切れの可能性)';
      return;
    }
    this.reconnecting = true;
    this.reconnectTries += 1;
    this.reconnectHandle = setTimeout(() => {
      this.reconnectHandle = null;
      this.openSocket();
    }, RECONNECT_INTERVAL_MS);
  }

  /**
   * 自陣の 1 打鍵/構えをバッチへ積む(ADR 0011 #2)。atMs はサーバーと同じウォール時計。
   * 実送信は INPUT_BATCH_MS 周期でまとめて行う(DO の起床回数を抑える)。
   */
  enqueueSelect(handIndex: number, atMs: number): void {
    this.pendingInput.push({ kind: 'select', handIndex, atMs });
  }
  enqueuePress(key: string, atMs: number): void {
    this.pendingInput.push({ kind: 'press', key, atMs });
  }

  /** バッチ送信ループを開始する(matchStart / matchResumed 後)。 */
  private startBatchLoop(): void {
    if (this.batchHandle !== null) {
      return;
    }
    this.batchHandle = setInterval(() => this.flushInput(), INPUT_BATCH_MS);
  }

  private stopBatchLoop(): void {
    if (this.batchHandle !== null) {
      clearInterval(this.batchHandle);
      this.batchHandle = null;
    }
  }

  /** たまった入力を 1 つの input メッセージで送る(空なら何もしない)。 */
  private flushInput(): void {
    if (this.pendingInput.length === 0 || this.socket === null) {
      return;
    }
    if (this.socket.readyState !== WebSocket.OPEN) {
      return; // 再接続待ち等。確定済みは権威 state で再同期するため取りこぼしは致命でない。
    }
    const commands = this.pendingInput;
    this.pendingInput = [];
    this.sendRaw({ type: 'input', commands });
  }

  /** 接続を閉じてリソースを解放する(画面離脱・再戦時)。再接続はしない。 */
  leave(): void {
    this.closedByUser = true;
    this.stopBatchLoop();
    if (this.reconnectHandle !== null) {
      clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.socket !== null) {
      try {
        this.socket.close(1000, 'left');
      } catch {
        // 既に閉じている等は無視。
      }
      this.socket = null;
    }
  }

  /** 再戦に同意する(決着後のみ有効。二重送信はガードする, ADR 0011 #17)。 */
  requestRematch(): void {
    if (this.phase !== 'ended' || this.rematchSelfRequested) {
      return;
    }
    this.rematchSelfRequested = true;
    this.sendRaw({ type: 'rematchRequest' });
  }

  /** 生メッセージを送る(OPEN でなければ捨てる)。 */
  private sendRaw(msg: unknown): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      // 送信失敗は無視(close が続いて再接続経路へ入る)。
    }
  }
}

/** ルームコードから同一オリジンの WS URL を作る(http→ws / https→wss)。 */
function wsUrl(code: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/match/${encodeURIComponent(code)}`;
}
