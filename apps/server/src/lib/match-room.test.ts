import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MatchRoom, type Env } from './match-room.ts';
import { CARDS } from '../domain/engine/index.ts';
import { TypingSession } from '../domain/engine/index.ts';
import type { ServerMessage, InputCommand } from '../domain/match/index.ts';
import type { Card } from '../domain/engine/index.ts';

/**
 * DurableObject `MatchRoom` の B2 権威ループ統合テスト(2 接続シミュレーション)。
 *
 * Workers ランタイム(WebSocketPair)を最小限フェイクし、2 つの接続を join → submitDeck →
 * ready で開始させ、input(打鍵ストリーム)を流して setInterval の権威 tick(フェイクタイマ)を
 * 進め、両者へ state デルタ / matchEnd が push されることを検証する。
 * 細粒度の権威ルール(相打ち draw・時間切れ等)は domain の session.test.ts で担保し、
 * ここは「DO の配線(input → tick → push → matchEnd)」が動くことを確認する。
 */

const byId = (id: string): Card => {
  const c = CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
};
const romajiOf = (card: Card): string => new TypingSession(card.reading).remainingGuide;

/** 合法デッキ(各カード 2 枚 = 20 枚)。サーバー検証(20 枚/同種最大2/実在)を満たす。 */
const legalDeck = (): string[] => CARDS.flatMap((c) => [c.id, c.id]);

/** 1 カードを詠唱しきる input コマンド列。 */
function castCommands(handIndex: number, cardId: string, atMs: number): InputCommand[] {
  const cmds: InputCommand[] = [{ kind: 'select', handIndex, atMs }];
  for (const key of romajiOf(byId(cardId))) {
    cmds.push({ kind: 'press', key, atMs });
  }
  return cmds;
}

/** WebSocket のフェイク。emit で受信を擬似発火、sent で送信を回収する。 */
class FakeSocket {
  readonly sent: ServerMessage[] = [];
  private listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  accept(): void {}
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.emit('close');
  }
  /** テスト用: 受信メッセージを擬似発火する。 */
  emitMessage(msg: unknown): void {
    this.emit('message', { data: JSON.stringify(msg) });
  }
  private emit(type: string, ev: { data?: unknown } = {}): void {
    for (const fn of this.listeners[type] ?? []) {
      fn(ev);
    }
  }
  /** 指定 type の送信メッセージを抽出する。 */
  messagesOfType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
}

/** フェイク WebSocketPair。[0]=client(無視), [1]=server(テストで操作)。 */
let serverSockets: FakeSocket[] = [];

class FakeWebSocketPair {
  0: FakeSocket;
  1: FakeSocket;
  constructor() {
    const client = new FakeSocket();
    const server = new FakeSocket();
    serverSockets.push(server);
    this[0] = client;
    this[1] = server;
  }
}

/**
 * node の Response は status 101 + webSocket option を拒否するため、最小フェイクで差し替える。
 * DO の fetch は 101 + webSocket(client)を返すだけなので、テストでは中身を見ない。
 */
class FakeResponse {
  readonly status: number;
  readonly webSocket: unknown;
  constructor(_body: unknown, init?: { status?: number; webSocket?: unknown }) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }
}

/** DO id のフェイク(idFromName 相当のルームコード文字列を持つ)。 */
function fakeCtx(name: string): { id: { toString(): string } } {
  return { id: { toString: () => name } };
}

const env = {} as Env;

/** WS アップグレードの fetch を投げ、直近に生成された server ソケットを返す。 */
async function connect(room: MatchRoom): Promise<FakeSocket> {
  const before = serverSockets.length;
  await room.fetch(new Request('https://x/match/ROOM', { headers: { Upgrade: 'websocket' } }));
  return serverSockets[before];
}

describe('MatchRoom B2 権威ループ(2 接続シミュレーション)', () => {
  beforeEach(() => {
    serverSockets = [];
    vi.stubGlobal('WebSocketPair', FakeWebSocketPair);
    vi.stubGlobal('Response', FakeResponse);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 2 接続を開始状態にして両ソケットを返す。 */
  async function startMatch(): Promise<{ room: MatchRoom; a: FakeSocket; b: FakeSocket }> {
    const room = new MatchRoom(fakeCtx('ROOM') as never, env);
    const a = await connect(room);
    const b = await connect(room);
    for (const s of [a, b]) {
      s.emitMessage({ type: 'join' });
      s.emitMessage({ type: 'submitDeck', deckIds: legalDeck() });
      s.emitMessage({ type: 'ready' });
    }
    return { room, a, b };
  }

  it('両者 ready で matchStart が配られ、権威ループが開始する', async () => {
    const { room, a, b } = await startMatch();
    expect(a.messagesOfType('matchStart')).toHaveLength(1);
    expect(b.messagesOfType('matchStart')).toHaveLength(1);
    expect(room.matchSession).not.toBeNull();
    expect(room.matchEngine).not.toBeNull();
  });

  it('input → tick で相手へ state デルタが push され、HP が削れる', async () => {
    const { room, a, b } = await startMatch();
    // 手札は seed シャッフルで決まるため、A の実 snapshot から手札 0 のカード id を引く。
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    const startMsg = a.messagesOfType('matchStart')[0];
    const handCardId = session.snapshotFor(startMsg.selfId, Date.now()).self.hand[0].id;
    // A が手札 0 を詠唱する(全打鍵を 1 つの input バッチで送る)。
    a.emitMessage({ type: 'input', commands: castCommands(0, handCardId, Date.now()) });
    // 権威 tick を 1 回進める(setInterval 100ms)→ flush 後にデルタ push。
    await vi.advanceTimersByTimeAsync(120);
    // B 視点へ state が届き、被弾(self.hp 減少)が反映される。
    const bStates = b.messagesOfType('state');
    expect(bStates.length).toBeGreaterThan(0);
    const last = bStates[bStates.length - 1];
    expect(last.payload.self.hp).toBeLessThan(80); // A の発動で B が被弾
    expect(last.payload.opponent.hp).toBe(80); // A 自身は無傷
    // push ペイロードに self / opponent / timers / outcome が含まれる。
    expect(last.payload.timers).toBeDefined();
    expect(last.payload.outcome).toEqual({ kind: 'ongoing' });
  });

  it('KO で両者へ matchEnd(win/lose)が届き、tick が止まる(二重送信なし)', async () => {
    const { room, a, b } = await startMatch();
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    const selfId = a.messagesOfType('matchStart')[0].selfId;
    // A が毎ラウンド「現在の手札 0」を詠唱し、CD を跨いで繰り返して B を削り切る。
    // 手札はラウンドごとに補充されるため、その時点の hand[0] を実 snapshot から引いて打つ。
    for (let i = 0; i < 40 && !session.finished; i++) {
      const handCardId = session.snapshotFor(selfId, Date.now()).self.hand[0].id;
      a.emitMessage({ type: 'input', commands: castCommands(0, handCardId, Date.now()) });
      await vi.advanceTimersByTimeAsync(1600); // CD 1500ms を跨いで次の詠唱を受理させる
    }
    const aEnds = a.messagesOfType('matchEnd');
    const bEnds = b.messagesOfType('matchEnd');
    expect(aEnds).toHaveLength(1);
    expect(bEnds).toHaveLength(1);
    expect(aEnds[0].result.endReason).toBe('ko');
    expect(aEnds[0].outcome).toBe('win');
    expect(bEnds[0].outcome).toBe('lose');
    // 二重 push 解消(監査 nit): 終了 tick は通常デルタを送らず、最終 state は matchEnd の
    // 直前(endMatch)に 1 度だけ送られる。各接続で last(matchEnd)の直前が state であること、
    // かつ matchEnd は丁度 1 通であること(終了一度きり)を確認する。
    for (const s of [a, b]) {
      const endIdx = s.sent.findIndex((m) => m.type === 'matchEnd');
      expect(endIdx).toBeGreaterThan(0);
      expect(s.sent[endIdx - 1].type).toBe('state'); // 終了直前に最終 state を一本化
      // matchEnd 以降に state は送られない(終了 tick で通常 push をスキップしている)。
      expect(s.sent.slice(endIdx).some((m) => m.type === 'state')).toBe(false);
    }
    // B 視点の最終 state は self.hp=0(撃破された側)。matchEnd と一貫している。
    const bStates = b.messagesOfType('state');
    expect(bStates[bStates.length - 1].payload.self.hp).toBe(0);
    // 終了後はさらに tick を進めても matchEnd は二重送信されない(interval 停止)。
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.messagesOfType('matchEnd')).toHaveLength(1);
    expect(b.messagesOfType('matchEnd')).toHaveLength(1);
  });

  it('終了後 / 未開始の input は無視される', async () => {
    const room = new MatchRoom(fakeCtx('ROOM2') as never, env);
    const a = await connect(room);
    // 開始前に input を送っても session が無いので無視(例外にならない)。
    expect(() =>
      a.emitMessage({ type: 'input', commands: castCommands(0, 'wave', 1000) })
    ).not.toThrow();
    expect(room.matchSession).toBeNull();
  });

  it('全接続が消えると孤立した権威 tick が止まる(空回り防止)', async () => {
    const { room, a, b } = await startMatch();
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    // 開始直後は決着していない(tick が回っている)。
    expect(session.finished).toBe(false);
    // 両接続が切れると onClose で tick(setInterval)が止まる。
    a.close();
    b.close();
    // tick が止まっているので、時間を進めても deadline 超過の時間切れ決着が起きない。
    await vi.advanceTimersByTimeAsync(130_000); // 制限時間(既定 120s)を越える時間
    expect(session.finished).toBe(false);
    // ended は決着の不可逆状態であって接続消失とは別物。matchEnd は送られていない。
    expect(a.messagesOfType('matchEnd')).toHaveLength(0);
    expect(b.messagesOfType('matchEnd')).toHaveLength(0);
  });
});
