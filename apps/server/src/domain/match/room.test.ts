import { describe, it, expect } from 'vitest';
import {
  createRoom,
  join,
  submitDeck,
  markReady,
  canStart,
  tryStart,
  buildMatchConfig,
  roleOf,
  type RoomState,
} from './room.ts';
import { CARDS, MatchEngine } from '../engine/index.ts';

/** 合法デッキ(15 枚・同種最大 2)の ID 配列。 */
function legalDeckIds(): string[] {
  return [...CARDS.map((c) => c.id), ...CARDS.slice(0, 5).map((c) => c.id)];
}

/** join → 成功を前提に state を取り出すヘルパ。 */
function joinOrThrow(state: RoomState, id: string): RoomState {
  const r = join(state, id);
  if (!r.ok) {
    throw new Error(`join failed: ${r.error}`);
  }
  return r.value.state;
}

describe('ルームのライフサイクル', () => {
  it('create → join 2 人で full になり role が 0/1 で割り当てられる', () => {
    let room = createRoom('ABC123');
    expect(room.phase).toBe('waiting');

    const j1 = join(room, 'p1');
    expect(j1.ok).toBe(true);
    if (j1.ok) {
      expect(j1.value.role).toBe(0);
      room = j1.value.state;
    }
    expect(room.phase).toBe('waiting');

    const j2 = join(room, 'p2');
    expect(j2.ok).toBe(true);
    if (j2.ok) {
      expect(j2.value.role).toBe(1);
      room = j2.value.state;
    }
    expect(room.phase).toBe('full');
    expect(roleOf(room, 'p1')).toBe(0);
    expect(roleOf(room, 'p2')).toBe(1);
    expect(roleOf(room, 'unknown')).toBe(null);
  });

  it('満室への 3 人目は room_full エラー', () => {
    let room = createRoom('ABC123');
    room = joinOrThrow(room, 'p1');
    room = joinOrThrow(room, 'p2');
    const j3 = join(room, 'p3');
    expect(j3.ok).toBe(false);
    if (!j3.ok) {
      expect(j3.error).toBe('room_full');
    }
  });

  it('未知コード相当: roleOf は在席しない id に null を返す(routes が未知コードを弾く土台)', () => {
    const room = createRoom('ABC123');
    expect(roleOf(room, 'nobody')).toBe(null);
  });

  it('両者 submit(合法)→ 両者 ready → tryStart 可・MatchConfig に seed と両デッキが入る', () => {
    let room = createRoom('ABC123');
    room = joinOrThrow(room, 'p1');
    room = joinOrThrow(room, 'p2');

    const s1 = submitDeck(room, 'p1', legalDeckIds());
    expect(s1.ok).toBe(true);
    if (s1.ok) room = s1.value;
    const s2 = submitDeck(room, 'p2', legalDeckIds());
    expect(s2.ok).toBe(true);
    if (s2.ok) room = s2.value;

    // まだ ready していないので開始不可。
    expect(canStart(room)).toBe(false);

    const r1 = markReady(room, 'p1');
    expect(r1.ok).toBe(true);
    if (r1.ok) room = r1.value;
    expect(canStart(room)).toBe(false); // 片方だけ ready

    const r2 = markReady(room, 'p2');
    expect(r2.ok).toBe(true);
    if (r2.ok) room = r2.value;
    expect(canStart(room)).toBe(true);

    const start = tryStart(room, { masterSeed: 0xdead_beef });
    expect(start.ok).toBe(true);
    if (start.ok) {
      expect(start.value.state.phase).toBe('started');
      expect(start.value.playerIds).toEqual(['p1', 'p2']);
      // MatchConfig に両デッキ(15 枚)と seed が入る。
      expect(start.value.config.players[0].id).toBe('p1');
      expect(start.value.config.players[1].id).toBe('p2');
      expect(start.value.config.players[0].deck.length).toBe(15);
      expect(start.value.config.players[1].deck.length).toBe(15);
      expect(start.value.config.options?.masterSeed).toBe(0xdead_beef);
    }
  });

  it('デッキ変更で ready は解除される(再 ready 要求)', () => {
    let room = createRoom('ABC123');
    room = joinOrThrow(room, 'p1');
    room = joinOrThrow(room, 'p2');
    const s1 = submitDeck(room, 'p1', legalDeckIds());
    if (s1.ok) room = s1.value;
    const r1 = markReady(room, 'p1');
    if (r1.ok) room = r1.value;
    expect(room.slots[0]?.ready).toBe(true);
    // 再提出すると ready が落ちる。
    const s1b = submitDeck(room, 'p1', legalDeckIds());
    if (s1b.ok) room = s1b.value;
    expect(room.slots[0]?.ready).toBe(false);
  });

  it('不正デッキは submit で弾かれ start 不可', () => {
    let room = createRoom('ABC123');
    room = joinOrThrow(room, 'p1');
    room = joinOrThrow(room, 'p2');
    // p1 は不正(14 枚)。
    const bad = submitDeck(room, 'p1', legalDeckIds().slice(0, 14));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.kind).toBe('invalid_deck');
    }
    // p2 のみ合法提出 + ready しても、p1 が未提出のため開始不可。
    const s2 = submitDeck(room, 'p2', legalDeckIds());
    if (s2.ok) room = s2.value;
    const r2 = markReady(room, 'p2');
    if (r2.ok) room = r2.value;
    expect(canStart(room)).toBe(false);
    expect(tryStart(room, { masterSeed: 1 }).ok).toBe(false);
  });

  it('デッキ未提出での ready は no_deck エラー', () => {
    let room = createRoom('ABC123');
    room = joinOrThrow(room, 'p1');
    const r = markReady(room, 'p1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('no_deck');
    }
  });

  it('未知プレイヤーの submit/ready/start は弾かれる', () => {
    let room = createRoom('ABC123');
    room = joinOrThrow(room, 'p1');
    const s = submitDeck(room, 'ghost', legalDeckIds());
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.kind).toBe('unknown_player');
    const r = markReady(room, 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unknown_player');
  });

  it('開始済みルームへの join / submit / ready はエラー', () => {
    let room = createRoom('ABC123');
    room = joinOrThrow(room, 'p1');
    room = joinOrThrow(room, 'p2');
    const s1 = submitDeck(room, 'p1', legalDeckIds());
    if (s1.ok) room = s1.value;
    const s2 = submitDeck(room, 'p2', legalDeckIds());
    if (s2.ok) room = s2.value;
    const r1 = markReady(room, 'p1');
    if (r1.ok) room = r1.value;
    const r2 = markReady(room, 'p2');
    if (r2.ok) room = r2.value;
    const start = tryStart(room, { masterSeed: 7 });
    if (start.ok) room = start.value.state;
    expect(room.phase).toBe('started');

    expect(join(room, 'p3').ok).toBe(false);
    const sAfter = submitDeck(room, 'p1', legalDeckIds());
    expect(sAfter.ok).toBe(false);
    if (!sAfter.ok) expect(sAfter.error.kind).toBe('already_started');
    expect(markReady(room, 'p1').ok).toBe(false);
  });

  it('canStart が false なら tryStart は not_ready', () => {
    const room = createRoom('ABC123');
    const r = tryStart(room, { masterSeed: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_ready');
  });

  it('tryStart の MatchConfig は MatchEngine をそのまま生成・開始できる(seed 配布の接続)', () => {
    let room = createRoom('ABC123');
    room = joinOrThrow(room, 'p1');
    room = joinOrThrow(room, 'p2');
    const s1 = submitDeck(room, 'p1', legalDeckIds());
    if (s1.ok) room = s1.value;
    const s2 = submitDeck(room, 'p2', legalDeckIds());
    if (s2.ok) room = s2.value;
    const r1 = markReady(room, 'p1');
    if (r1.ok) room = r1.value;
    const r2 = markReady(room, 'p2');
    if (r2.ok) room = r2.value;

    const start = tryStart(room, { masterSeed: 12345 });
    expect(start.ok).toBe(true);
    if (start.ok) {
      const { config } = start.value;
      // DO が B1 で行うのと同じく config から権威エンジンを生成できる。
      const engine = new MatchEngine(config.players, config.options);
      engine.start(0);
      const snap = engine.snapshot('p1');
      expect(snap.self.hp).toBe(config.options?.maxHp);
      expect(snap.outcome.kind).toBe('ongoing');
      // 同一 seed なら同一引き順(決定論)。
      const engine2 = new MatchEngine(config.players, config.options);
      engine2.start(0);
      expect(engine2.snapshot('p1').self.hand.map((c) => c.id)).toEqual(
        snap.self.hand.map((c) => c.id)
      );
    }
  });

  it('buildMatchConfig は seed/maxHp/timeLimitMs を options に詰める', () => {
    const deck = CARDS.slice(0, 1);
    const config = buildMatchConfig(
      { id: 'a', deck },
      { id: 'b', deck },
      { masterSeed: 42, maxHp: 99, timeLimitMs: 30000 }
    );
    expect(config.options?.masterSeed).toBe(42);
    expect(config.options?.maxHp).toBe(99);
    expect(config.options?.timeLimitMs).toBe(30000);
    expect(config.players[0].id).toBe('a');
    expect(config.players[1].id).toBe('b');
  });
});
