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

/** 合法デッキ(15 枚・同種最大 2)。サーバー検証(15 枚/同種最大2/実在)を満たす。 */
const legalDeck = (): string[] => [
  ...CARDS.map((c) => c.id),
  ...CARDS.slice(0, 5).map((c) => c.id),
];

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

/**
 * DurableObjectStorage の最小フェイク(ADR 0012)。MatchRoom が使う API のみ実装する:
 * get / put / delete / deleteAll / setAlarm / getAlarm / deleteAlarm。値は structuredClone で
 * コピーして「保存後に元オブジェクトを変えても保存値が汚れない」実ストレージの意味論を再現する。
 * triggerAlarm() で予約済み alarm を手動発火し、DO の alarm() ハンドラを駆動する(退避中発火の擬似)。
 */
class FakeStorage {
  private readonly map = new Map<string, unknown>();
  private alarmAt: number | null = null;
  /** alarm() を呼ぶための DO 参照(fakeCtx 経由で後から差し込む)。 */
  owner: { alarm(): Promise<void> } | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.map.clear();
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
  /** テスト用: 予約時刻(壁時計 ms)。未予約は null。 */
  get scheduledAlarm(): number | null {
    return this.alarmAt;
  }
  /** テスト用: 予約済み alarm を発火して DO の alarm() を駆動する(退避中発火の擬似)。 */
  async triggerAlarm(): Promise<void> {
    this.alarmAt = null;
    await this.owner?.alarm();
  }
}

/** DO id + storage のフェイク。storage を渡せば「同じ storage で DO を再起動」を擬似できる。 */
function fakeCtx(
  name: string,
  storage: FakeStorage = new FakeStorage()
): {
  id: { toString(): string };
  storage: FakeStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  ready: Promise<unknown>;
} {
  let resolveReady: (v: unknown) => void = () => {};
  const ready = new Promise((r) => {
    resolveReady = r;
  });
  return {
    id: { toString: () => name },
    storage,
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const p = fn();
      // restore 完了を待てるよう ready を解決する(テストは await ctx.ready で同期できる)。
      void p.then(resolveReady, resolveReady);
      return p;
    },
    ready,
  };
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

  /** 2 接続を開始状態にして両ソケットを返す(storage も返し、再起動 / alarm テストで使う)。 */
  async function startMatch(): Promise<{
    room: MatchRoom;
    a: FakeSocket;
    b: FakeSocket;
    storage: FakeStorage;
  }> {
    const storage = new FakeStorage();
    const ctx = fakeCtx('ROOM', storage);
    const room = new MatchRoom(ctx as never, env);
    storage.owner = room; // alarm 発火を DO へ橋渡しする。
    await ctx.ready; // 起動時 restore の完了を待つ(新規ルームは即 resolve)。
    const a = await connect(room);
    const b = await connect(room);
    for (const s of [a, b]) {
      s.emitMessage({ type: 'join' });
      s.emitMessage({ type: 'submitDeck', deckIds: legalDeck() });
      s.emitMessage({ type: 'ready' });
    }
    return { room, a, b, storage };
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

  it('進行中の切断は権威時計を凍結し、相手へ切断通知(B3, ADR 0011 #8/#11)', async () => {
    const { room, a, b } = await startMatch();
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    expect(session.paused).toBe(false);
    // A(role 0)が切断 → 権威時計が凍結し、B(相手)へ paused=true が届く。
    a.close();
    expect(session.paused).toBe(true);
    const oppConn = b.messagesOfType('opponentConnection');
    expect(oppConn[oppConn.length - 1].paused).toBe(true);
    // 猶予内(30s 未満)は決着しない(凍結中は forfeit が走らない)。
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.finished).toBe(false);
    expect(b.messagesOfType('matchEnd')).toHaveLength(0);
  });

  it('切断猶予を超過すると切断側の forfeit 負けで matchEnd(B3, ADR 0011 #8/#12)', async () => {
    const { room, a, b } = await startMatch();
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    // A が切断したまま猶予(30s)を超過 → A の forfeit、B の win。
    a.close();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(session.finished).toBe(true);
    expect(session.result?.endReason).toBe('forfeit');
    // 在席の B へ matchEnd(win)が届く(切断済みの A へは送れないが二重決着しない)。
    const bEnds = b.messagesOfType('matchEnd');
    expect(bEnds).toHaveLength(1);
    expect(bEnds[0].outcome).toBe('win');
    expect(bEnds[0].result.endReason).toBe('forfeit');
  });

  it('猶予内に再接続すると席へ復帰し権威時計が再開する(B3, ADR 0011 #8/#11)', async () => {
    const { room, a, b } = await startMatch();
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    // A の元の席 id(engine の playerId)= matchStart の selfId。
    const aSeatId = a.messagesOfType('matchStart')[0].selfId;
    // A が切断 → 凍結。
    a.close();
    expect(session.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); // 猶予内
    // A が resumeId 付きで再接続 → 席復帰 → 凍結解除。
    const a2 = await connect(room);
    a2.emitMessage({ type: 'join', resumeId: aSeatId });
    expect(session.paused).toBe(false);
    // 復帰側へ matchResumed(seed/self/opponent)+ 現況 state が届く。
    const resumed = a2.messagesOfType('matchResumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0].selfId).toBe(aSeatId);
    expect(a2.messagesOfType('state').length).toBeGreaterThan(0);
    // 相手 B へ paused=false(再開)が届く。
    const oppConn = b.messagesOfType('opponentConnection');
    expect(oppConn[oppConn.length - 1].paused).toBe(false);
    // 復帰後の入力が正しい陣営(A の席)へ通る: A が詠唱すると B が被弾する。
    const handCardId = session.snapshotFor(aSeatId, Date.now()).self.hand[0].id;
    a2.emitMessage({ type: 'input', commands: castCommands(0, handCardId, Date.now()) });
    await vi.advanceTimersByTimeAsync(300);
    expect(session.snapshotFor(aSeatId, Date.now()).opponent.hp).toBeLessThan(80);
    // 猶予を超過しても決着しない(再接続でタイマがクリアされている)。
    await vi.advanceTimersByTimeAsync(31_000);
    expect(session.result?.endReason).not.toBe('forfeit');
  });
});

/**
 * DO Storage 永続化 + Alarms 堅牢化(ADR 0012)の統合テスト。
 *
 * 退避/再起動/クラッシュで試合とタイマが消える弱点を、storage チェックポイント + alarm で
 * 塞いだことを検証する。FakeStorage を「同じ storage で DO を作り直す」ことで退避→復元を擬似し、
 * triggerAlarm で「DO 退避中の alarm 発火」を擬似する。
 */
describe('MatchRoom DO Storage 永続化 + Alarms(ADR 0012)', () => {
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

  /** storage を渡して 2 接続を開始状態にする(再起動テストで同じ storage を使い回す)。 */
  async function startMatchOn(
    storage: FakeStorage
  ): Promise<{ room: MatchRoom; a: FakeSocket; b: FakeSocket }> {
    const ctx = fakeCtx('ROOM', storage);
    const room = new MatchRoom(ctx as never, env);
    storage.owner = room;
    await ctx.ready;
    const a = await connect(room);
    const b = await connect(room);
    for (const s of [a, b]) {
      s.emitMessage({ type: 'join' });
      s.emitMessage({ type: 'submitDeck', deckIds: legalDeck() });
      s.emitMessage({ type: 'ready' });
    }
    return { room, a, b };
  }

  it('matchStart で試合状態が storage へ checkpoint され、時間切れ alarm が予約される', async () => {
    const storage = new FakeStorage();
    const { room } = await startMatchOn(storage);
    // 1 キーへまとめて永続化されている(復元の入口)。
    const persisted = await storage.get<{ ended: boolean; playerIds: string[] }>('match');
    expect(persisted).toBeDefined();
    expect(persisted?.ended).toBe(false);
    expect(persisted?.playerIds).toHaveLength(2);
    // 時間切れ deadline(= startWall + timeLimit 120s + INPUT_DELAY)で alarm が予約されている。
    expect(storage.scheduledAlarm).not.toBeNull();
    expect(storage.scheduledAlarm).toBeGreaterThan(Date.now() + 120_000);
    expect(room.wasRestored).toBe(false);
  });

  it('DO 退避→復元(同じ storage で再起動)で試合状態が継続する(storage round-trip)', async () => {
    const storage = new FakeStorage();
    const { room, a } = await startMatchOn(storage);
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    const aSeatId = a.messagesOfType('matchStart')[0].selfId;
    const bSeatId = a.messagesOfType('matchStart')[0].opponentId;
    // A が 1 枚詠唱して B を削る(意味的変化 = checkpoint 契機)。
    const handCardId = session.snapshotFor(aSeatId, Date.now()).self.hand[0].id;
    a.emitMessage({ type: 'input', commands: castCommands(0, handCardId, Date.now()) });
    await vi.advanceTimersByTimeAsync(300);
    const bHpBefore = session.snapshotFor(bSeatId, Date.now()).self.hp;
    const aTypedBefore = session.snapshotFor(aSeatId, Date.now()).self.hand.map((c) => c.id);
    expect(bHpBefore).toBeLessThan(80);

    // 退避→再起動: 同じ storage で新しい DO を作る(メモリは失われ storage から復元)。
    const ctx2 = fakeCtx('ROOM', storage);
    const room2 = new MatchRoom(ctx2 as never, env);
    storage.owner = room2;
    await ctx2.ready;
    expect(room2.wasRestored).toBe(true);
    const session2 = room2.matchSession;
    if (session2 === null) throw new Error('restored session is null');
    // 復元後の権威状態が退避前と一致する(HP・手札・決着していない)。
    expect(session2.snapshotFor(bSeatId, Date.now()).self.hp).toBe(bHpBefore);
    expect(session2.snapshotFor(aSeatId, Date.now()).self.hand.map((c) => c.id)).toEqual(
      aTypedBefore
    );
    expect(session2.finished).toBe(false);
    // 復元後に再接続した A の入力が正しい陣営へ通る(席 id 固定が復元されている)。
    const a2 = await connect(room2);
    a2.emitMessage({ type: 'join', resumeId: aSeatId });
    expect(a2.messagesOfType('matchResumed')).toHaveLength(1);
    // 1 枚目の発動で入ったクールダウンが明けてから 2 枚目を詠唱する
    // (クールダウン中の打鍵は受理されないため。先行入力は廃止済み)。
    await vi.advanceTimersByTimeAsync(2000);
    const handCardId2 = session2.snapshotFor(aSeatId, Date.now()).self.hand[0].id;
    a2.emitMessage({ type: 'input', commands: castCommands(0, handCardId2, Date.now()) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(session2.snapshotFor(bSeatId, Date.now()).self.hp).toBeLessThan(bHpBefore);
  });

  it('退避中の alarm 発火で切断猶予超過の forfeit が決着する(setInterval/setTimeout なしでも)', async () => {
    const storage = new FakeStorage();
    const { room, a, b } = await startMatchOn(storage);
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    // A が切断 → 凍結 + 猶予 deadline + alarm が grace 期限へ張り替わる。
    a.close();
    expect(session.paused).toBe(true);
    const graceDeadline = storage.scheduledAlarm;
    expect(graceDeadline).not.toBeNull();
    // 退避→復元(同じ storage で再起動)。setInterval/setTimeout はメモリと共に失われる。
    const ctx2 = fakeCtx('ROOM', storage);
    const room2 = new MatchRoom(ctx2 as never, env);
    storage.owner = room2;
    await ctx2.ready;
    const session2 = room2.matchSession;
    if (session2 === null) throw new Error('restored session is null');
    // 復元後も pause が復帰している(grace deadline も復元)。
    expect(session2.paused).toBe(true);
    // 退避中に wall 時計が grace 期限を越え、alarm が発火 → forfeit で決着する。
    vi.setSystemTime((graceDeadline as number) + 1000);
    await storage.triggerAlarm();
    expect(session2.finished).toBe(true);
    expect(session2.result?.endReason).toBe('forfeit');
    // 在席だった B の WS はこの新 DO には無いが、二重決着せず永続データは掃除されている。
    expect(await storage.get('match')).toBeUndefined();
    expect(storage.scheduledAlarm).toBeNull();
    // B は別 DO(room2)の接続ではないので matchEnd は room2 からは届かない(WS 揮発)。
    void b;
  });

  it('退避中の alarm 発火で制限時間切れが finalize される(両者無通信でも決着)', async () => {
    const storage = new FakeStorage();
    const { room } = await startMatchOn(storage);
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    const timeUpAlarm = storage.scheduledAlarm;
    expect(timeUpAlarm).not.toBeNull();
    // 退避→復元(同じ storage で再起動)。
    const ctx2 = fakeCtx('ROOM', storage);
    const room2 = new MatchRoom(ctx2 as never, env);
    storage.owner = room2;
    await ctx2.ready;
    const session2 = room2.matchSession;
    if (session2 === null) throw new Error('restored session is null');
    expect(session2.finished).toBe(false);
    // 退避中に制限時間 deadline を越え、alarm が発火 → 時間切れで finalize(残 HP 同値 = draw)。
    vi.setSystemTime((timeUpAlarm as number) + 1000);
    await storage.triggerAlarm();
    expect(session2.finished).toBe(true);
    expect(session2.result?.endReason).toBe('timeup');
    // 決着後は永続データと alarm が掃除されている。
    expect(await storage.get('match')).toBeUndefined();
    expect(storage.scheduledAlarm).toBeNull();
  });

  it('pause 中は時間切れ alarm を予約せず、resume で再スケジュールする(pause 追従, ADR 0012)', async () => {
    const storage = new FakeStorage();
    const { room, a } = await startMatchOn(storage);
    const session = room.matchSession;
    if (session === null) throw new Error('session is null');
    const aSeatId = a.messagesOfType('matchStart')[0].selfId;
    const timeUpBefore = storage.scheduledAlarm as number;
    // A が切断 → pause。alarm は grace 期限(= now + 30s)へ張り替わる(時間切れ deadline より早い)。
    a.close();
    const graceAlarm = storage.scheduledAlarm as number;
    expect(graceAlarm).toBeLessThan(timeUpBefore);
    expect(graceAlarm).toBe(Date.now() + 30_000);
    // 10s 経って再接続 → resume。凍結ぶん(10s)だけ時間切れ deadline が後ろへずれて再予約される。
    await vi.advanceTimersByTimeAsync(10_000);
    const a2 = await connect(room);
    a2.emitMessage({ type: 'join', resumeId: aSeatId });
    expect(session.paused).toBe(false);
    const timeUpAfter = storage.scheduledAlarm as number;
    // resume 後は時間切れ deadline が復活し、凍結していた 10s ぶん後ろへずれている(pause 追従)。
    expect(timeUpAfter).toBeGreaterThanOrEqual(timeUpBefore + 10_000 - 5);
  });
});
