import { describe, it, expect } from 'vitest';
import { VersusRoom } from './room';
import { STARTER_DECK } from '../cards';

/**
 * 決定論的な疑似乱数(mulberry32)。battle.test.ts と同じ。
 * 固定シードで山札のシャッフル(=初期手札)を再現する。
 */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * シード12345での初期手札(STARTER_DECK基準)。
 * 両プレイヤーは同じ rng を共有するが、乱数列を順に消費するため手札は別物になる:
 *   alice = [meteor(18), gale(6), gale(6), blaze(10)]
 *   bob   = [meteor(18), blaze(10), thunder, thunder]
 */
const SEED = 12345;

/** 各カードのデフォルトローマ字(動的ガイドの全文) */
const ROMAJI: Record<string, string> = {
  meteor: 'tennyorihurisosoguryuuseiyotekiwoutikudake',
  gale: 'kazenoyaibayokakenukero',
  blaze: 'uzumakuhonooyotekiwotutumikome',
};

/** 2人参加して開始済みのルームを作る(playerHp 指定可) */
function makeStartedRoom(playerHp?: number): VersusRoom {
  const room = new VersusRoom('room-1', { playerHp, rng: mulberry32(SEED) });
  room.join('alice', STARTER_DECK, 0);
  room.join('bob', STARTER_DECK, 0);
  room.start(1000);
  return room;
}

/** 指定プレイヤーがカードを構えてローマ字を打ち切る */
function castFull(
  room: VersusRoom,
  playerId: string,
  handIndex: number,
  cardId: string,
  atMs: number
): void {
  room.selectCard(playerId, handIndex, atMs);
  const romaji = ROMAJI[cardId];
  for (let i = 0; i < romaji.length; i++) {
    room.pressKey(playerId, romaji[i], atMs);
  }
}

describe('状態遷移', () => {
  it('参加前は waiting、1人で waiting、2人で ready、start で inProgress', () => {
    const room = new VersusRoom('r', { rng: mulberry32(SEED) });
    expect(room.status).toBe('waiting');
    room.join('alice', STARTER_DECK, 0);
    expect(room.status).toBe('waiting');
    room.join('bob', STARTER_DECK, 0);
    expect(room.status).toBe('ready');
    room.start(1000);
    expect(room.status).toBe('inProgress');
    expect(room.winnerId).toBeNull();
  });

  it('3人目の join はエラー', () => {
    const room = new VersusRoom('r', { rng: mulberry32(SEED) });
    room.join('alice', STARTER_DECK, 0);
    room.join('bob', STARTER_DECK, 0);
    expect(() => room.join('carol', STARTER_DECK, 0)).toThrow();
  });

  it('重複 playerId の join はエラー', () => {
    const room = new VersusRoom('r', { rng: mulberry32(SEED) });
    room.join('alice', STARTER_DECK, 0);
    expect(() => room.join('alice', STARTER_DECK, 0)).toThrow();
  });

  it('start は ready 以外では何もしない', () => {
    const room = new VersusRoom('r', { rng: mulberry32(SEED) });
    room.start(1000); // waiting
    expect(room.status).toBe('waiting');
    room.join('alice', STARTER_DECK, 0);
    room.start(1000); // 1人(waiting)
    expect(room.status).toBe('waiting');
  });

  it('inProgress 以外での start は無視される(二重開始しない)', () => {
    const room = makeStartedRoom();
    room.start(2000); // 既に inProgress
    expect(room.status).toBe('inProgress');
    expect(room.events.filter((e) => e.type === 'started')).toHaveLength(1);
  });
});

describe('inProgress 外の操作', () => {
  it('start 前の pressKey は blocked', () => {
    const room = new VersusRoom('r', { rng: mulberry32(SEED) });
    room.join('alice', STARTER_DECK, 0);
    room.join('bob', STARTER_DECK, 0); // ready だが未 start
    expect(room.pressKey('alice', 't', 100)).toBe('blocked');
  });

  it('inProgress 外の selectCard は何もしない', () => {
    const room = new VersusRoom('r', { rng: mulberry32(SEED) });
    room.join('alice', STARTER_DECK, 0);
    room.join('bob', STARTER_DECK, 0);
    room.selectCard('alice', 0, 100); // ready 中
    expect(room.snapshotFor('alice', 100).own.selectedIndex).toBeNull();
  });

  it('不明な playerId の pressKey / selectCard / forfeit はエラー', () => {
    const room = makeStartedRoom();
    expect(() => room.pressKey('ghost', 't', 100)).toThrow();
    expect(() => room.selectCard('ghost', 0, 100)).toThrow();
    expect(() => room.forfeit('ghost', 100)).toThrow();
  });
});

describe('勝敗確定(削り切り)', () => {
  it('相手HPを先に削り切った側が勝つ', () => {
    // playerHp 18: meteor(18) 1発で相手HPを削り切る
    const room = makeStartedRoom(18);
    castFull(room, 'alice', 0, 'meteor', 2000);

    expect(room.status).toBe('finished');
    expect(room.winnerId).toBe('alice');
    const finished = room.events.find((e) => e.type === 'finished');
    expect(finished).toEqual({
      type: 'finished',
      winnerId: 'alice',
      reason: 'victory',
      atMs: 2000,
    });
  });

  it('両者が打鍵し、先に削り切った側が勝つ', () => {
    // playerHp 24: meteor(18) + gale(6) の2発で削り切る
    const room = makeStartedRoom(24);
    // alice が meteor を撃つ(残り6)
    castFull(room, 'alice', 0, 'meteor', 2000);
    // bob も meteor を撃つ(残り6)だがまだ勝者は出ていない
    castFull(room, 'bob', 0, 'meteor', 2000);
    expect(room.status).toBe('inProgress');
    // alice が gale を撃って削り切る(クールダウン明けの時刻)
    castFull(room, 'alice', 1, 'gale', 4000);
    expect(room.status).toBe('finished');
    expect(room.winnerId).toBe('alice');
  });

  it('決着後の pressKey は blocked、勝者は変わらない', () => {
    const room = makeStartedRoom(18);
    castFull(room, 'alice', 0, 'meteor', 2000);
    expect(room.pressKey('bob', 't', 3000)).toBe('blocked');
    expect(room.winnerId).toBe('alice');
  });
});

describe('forfeit(離脱)', () => {
  it('離脱すると相手の勝ちで即終了する', () => {
    const room = makeStartedRoom();
    room.forfeit('alice', 2000);
    expect(room.status).toBe('finished');
    expect(room.winnerId).toBe('bob');
    const finished = room.events.find((e) => e.type === 'finished');
    expect(finished).toEqual({ type: 'finished', winnerId: 'bob', reason: 'forfeit', atMs: 2000 });
  });

  it('inProgress 以外での forfeit は何もしない', () => {
    const room = new VersusRoom('r', { rng: mulberry32(SEED) });
    room.join('alice', STARTER_DECK, 0);
    room.join('bob', STARTER_DECK, 0); // ready
    room.forfeit('alice', 2000);
    expect(room.status).toBe('ready');
    expect(room.winnerId).toBeNull();
  });

  it('決着後の forfeit は勝者を変えない', () => {
    const room = makeStartedRoom(18);
    castFull(room, 'alice', 0, 'meteor', 2000);
    room.forfeit('alice', 3000);
    expect(room.winnerId).toBe('alice');
  });
});

describe('スナップショット', () => {
  it('自分側は完全なバトル状態、status/winnerId/roomId を含む', () => {
    const room = makeStartedRoom();
    const snap = room.snapshotFor('alice', 1000);
    expect(snap.roomId).toBe('room-1');
    expect(snap.status).toBe('inProgress');
    expect(snap.winnerId).toBeNull();
    expect(snap.own.hand).toHaveLength(4);
    expect(snap.own.hand[0].id).toBe('meteor');
  });

  it('相手側は公開情報(playerId/hp/maxHp/finished)のみで手札やお題を含まない', () => {
    const room = makeStartedRoom();
    const opp = room.snapshotFor('alice', 1000).opponent;
    expect(opp).toEqual({ playerId: 'bob', hp: 50, maxHp: 50, finished: false });
    // 手札・お題・入力途中の情報が漏れていないこと
    expect(Object.keys(opp).sort()).toEqual(['finished', 'hp', 'maxHp', 'playerId']);
    expect(opp).not.toHaveProperty('hand');
    expect(opp).not.toHaveProperty('typedRomaji');
    expect(opp).not.toHaveProperty('selectedIndex');
    expect(opp).not.toHaveProperty('remainingGuide');
  });

  it('自分のHPは相手の打鍵で減り、双方の視点で整合する', () => {
    const room = makeStartedRoom(50);
    castFull(room, 'bob', 0, 'meteor', 2000); // bob が meteor(damage18) を alice へ
    const aliceSnap = room.snapshotFor('alice', 2000);
    expect(aliceSnap.ownHp).toBe(32); // 50 - 18
    expect(aliceSnap.ownMaxHp).toBe(50);
    // bob 視点の「相手HP」と alice 視点の「自分HP」は同じ値
    expect(room.snapshotFor('bob', 2000).opponent.hp).toBe(32);
  });

  it('相手HPは自分のエンジンの的HPで、自分の打鍵で減る', () => {
    const room = makeStartedRoom(50);
    castFull(room, 'alice', 1, 'gale', 2000); // gale damage6
    const snap = room.snapshotFor('alice', 2000);
    expect(snap.opponent.hp).toBe(44); // 50 - 6
  });

  it('決着後は status=finished・winnerId・相手の finished=true が見える', () => {
    const room = makeStartedRoom(18);
    castFull(room, 'alice', 0, 'meteor', 2000);
    const snap = room.snapshotFor('alice', 2000);
    expect(snap.status).toBe('finished');
    expect(snap.winnerId).toBe('alice');
    expect(snap.opponent.hp).toBe(0);
    expect(snap.opponent.finished).toBe(true);
  });
});

describe('イベントログ', () => {
  it('joined / started が atMs 付きで記録される', () => {
    const room = new VersusRoom('r', { rng: mulberry32(SEED) });
    room.join('alice', STARTER_DECK, 100);
    room.join('bob', STARTER_DECK, 200);
    room.start(1000);
    expect(room.events).toEqual([
      { type: 'joined', playerId: 'alice', atMs: 100 },
      { type: 'joined', playerId: 'bob', atMs: 200 },
      { type: 'started', atMs: 1000 },
    ]);
  });
});
