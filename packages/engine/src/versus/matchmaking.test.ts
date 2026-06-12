import { describe, it, expect } from 'vitest';
import { MatchmakingQueue } from './matchmaking';

describe('待機列の基本', () => {
  it('最初の enqueue は相手がいないので null を返して列に積む', () => {
    const queue = new MatchmakingQueue();
    expect(queue.enqueue('alice', 100)).toBeNull();
    expect(queue.waitingCount).toBe(1);
    expect(queue.snapshot()).toEqual(['alice']);
  });

  it('2人目の enqueue で組が成立し両者が列から外れる', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('alice', 100);
    const pair = queue.enqueue('bob', 200);
    expect(pair).toEqual({ players: ['alice', 'bob'] });
    expect(queue.waitingCount).toBe(0);
    expect(queue.snapshot()).toEqual([]);
  });
});

describe('FIFO 順で組にする', () => {
  it('到着順に2人ずつ組まれる', () => {
    const queue = new MatchmakingQueue();
    // a が待機 → b が来て (a,b) 成立
    expect(queue.enqueue('a', 1)).toBeNull();
    expect(queue.enqueue('b', 2)).toEqual({ players: ['a', 'b'] });
    // c が待機 → d が来て (c,d) 成立
    expect(queue.enqueue('c', 3)).toBeNull();
    expect(queue.enqueue('d', 4)).toEqual({ players: ['c', 'd'] });
    expect(queue.waitingCount).toBe(0);
  });

  it('cancel で先頭が抜けると次の待機者が先頭として組まれる', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('a', 1); // a が待機
    queue.cancel('a', 2); // a が抜ける
    queue.enqueue('b', 3); // b が待機(先頭)
    expect(queue.enqueue('c', 4)).toEqual({ players: ['b', 'c'] });
  });

  it('奇数人だと最後の1人が待機に残る', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('a', 1);
    queue.enqueue('b', 2); // a と b が成立
    queue.enqueue('c', 3); // c が待機に残る
    expect(queue.snapshot()).toEqual(['c']);
  });
});

describe('重複 enqueue', () => {
  it('待機中の playerId を再度 enqueue するとエラー', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('alice', 100);
    expect(() => queue.enqueue('alice', 200)).toThrow();
  });

  it('組が成立して列から外れた後なら再度 enqueue できる', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('alice', 100);
    queue.enqueue('bob', 200); // alice は組んで列から外れた
    expect(() => queue.enqueue('alice', 300)).not.toThrow();
    expect(queue.snapshot()).toEqual(['alice']);
  });
});

describe('cancel', () => {
  it('待機中のプレイヤーを列から外す', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('alice', 100);
    queue.cancel('alice', 150);
    expect(queue.waitingCount).toBe(0);
    expect(queue.snapshot()).toEqual([]);
  });

  it('cancel 後はそのプレイヤーと組まれない(順序が保たれる)', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('a', 1);
    queue.enqueue('b', 2); // a,b 成立で空になる
    queue.enqueue('c', 3);
    queue.enqueue('d', 4); // c,d 成立で空
    queue.enqueue('e', 5);
    queue.cancel('e', 6); // e を取り消し
    expect(queue.enqueue('f', 7)).toBeNull(); // 相手がいないので待機
  });

  it('列にいない playerId の cancel は何もしない(冪等)', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('alice', 100);
    expect(() => queue.cancel('ghost', 150)).not.toThrow();
    expect(queue.snapshot()).toEqual(['alice']);
    // イベントも増えない
    expect(queue.events.filter((e) => e.type === 'cancelled')).toHaveLength(0);
  });
});

describe('イベントログ', () => {
  it('enqueued / matched / cancelled が atMs 付きで記録される', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('alice', 100); // enqueued
    queue.cancel('alice', 150); // cancelled
    queue.enqueue('bob', 200); // enqueued
    queue.enqueue('carol', 300); // matched(bob, carol)

    expect(queue.events).toEqual([
      { type: 'enqueued', playerId: 'alice', atMs: 100 },
      { type: 'cancelled', playerId: 'alice', atMs: 150 },
      { type: 'enqueued', playerId: 'bob', atMs: 200 },
      { type: 'matched', players: ['bob', 'carol'], atMs: 300 },
    ]);
  });

  it('matched イベントは組にした2人だけで enqueued を残さない', () => {
    const queue = new MatchmakingQueue();
    queue.enqueue('alice', 100);
    queue.enqueue('bob', 200);
    // 2人目は enqueued されず matched のみ
    const types = queue.events.map((e) => e.type);
    expect(types).toEqual(['enqueued', 'matched']);
  });
});
