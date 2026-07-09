/**
 * ルームのライフサイクル(ADR 0011 #5/#6/#7)。純 TS(Hono/Workers 非依存, ADR 0004)。
 *
 * 1 マッチ = 1 Durable Object(ADR 0011 #5)の DO がこの `RoomState` を保持し、
 * 操作関数群(join / submitDeck / markReady / tryStart)で状態遷移させる。
 * マッチングはルームコード(プライベート, ADR 0011 #6)で、一方が作成し他方が参加する。
 * 識別はエフェメラル ID(ADR 0011 #7)で、DO 側が接続時に発行してここへ渡す。
 *
 * 副作用(乱数・WebSocket・時刻)はすべて呼び出し側(DO)が注入する。とくに
 * masterSeed の「生成」(乱数源)は domain の外に置き(DO が crypto/Math.random で生成)、
 * ここは受け取った seed を MatchConfig へ詰めるだけにして純粋性を保つ(ADR 0011 #7/#13)。
 *
 * 不正(満室への 3 人目・未知コード・不正デッキ・未提出 / 未 ready での開始)は
 * 例外ではなく結果型(`Ok` / `Err`)で返す。
 */

import type { Card } from '../engine/index.ts';
import type { MatchConfig } from '../engine/index.ts';
import { MATCH_DEFAULT_HP, MATCH_DEFAULT_TIME_LIMIT_MS } from '../engine/index.ts';
import { validateDeck } from './deck.ts';

/** 結果型(例外を使わず合否を値で返す, ADR 0011 #7)。 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** ルームの席。0 が先入り(作成者)、1 が後入り(参加者)。 */
export type SlotRole = 0 | 1;

/** 1 席の状態。空席は null。 */
export interface Slot {
  /** サーバー発行のエフェメラル ID(DO が接続時に crypto.randomUUID で発行)。 */
  readonly ephemeralId: string;
  /** 提出済みデッキ(解決済み Card 配列)。未提出は null。検証は submitDeck で済ませる。 */
  readonly deck: readonly Card[] | null;
  /** ready 表明済みか。 */
  readonly ready: boolean;
}

/** ルームの局面。waiting=1 人待ち / full=2 人 / started=マッチ開始済み。 */
export type RoomPhase = 'waiting' | 'full' | 'started';

/** ルームの全状態。DO が 1 インスタンスをメモリ保持する(B1 はハイバネーション無し)。 */
export interface RoomState {
  /** ルームコード(プライベート, ADR 0011 #6)。 */
  readonly code: string;
  /** 2 席(index = role)。 */
  readonly slots: readonly [Slot | null, Slot | null];
  readonly phase: RoomPhase;
}

/** 新しい空ルームを作る。 */
export function createRoom(code: string): RoomState {
  return { code, slots: [null, null], phase: 'waiting' };
}

/** join のエラー。 */
export type JoinError = 'room_full' | 'already_started';

/** join 成功時の戻り。割り当てられた role と更新後の state。 */
export interface JoinResult {
  readonly role: SlotRole;
  readonly state: RoomState;
}

/**
 * エフェメラル ID で空席へ参加する(ADR 0011 #6/#7)。
 * 空席があれば若い index へ着席し role を返す。満室なら room_full、
 * 開始済みなら already_started を返す(満室への 3 人目はここで弾く)。
 */
export function join(state: RoomState, ephemeralId: string): Result<JoinResult, JoinError> {
  if (state.phase === 'started') {
    return err('already_started');
  }
  const freeIndex = state.slots.findIndex((s) => s === null);
  if (freeIndex === -1) {
    return err('room_full');
  }
  const role = freeIndex as SlotRole;
  const slot: Slot = { ephemeralId, deck: null, ready: false };
  const slots = withSlot(state.slots, role, slot);
  const phase: RoomPhase = slots[0] !== null && slots[1] !== null ? 'full' : 'waiting';
  return ok({ role, state: { ...state, slots, phase } });
}

/** submitDeck のエラー。 */
export type SubmitDeckError =
  | { readonly kind: 'unknown_player' }
  | { readonly kind: 'already_started' }
  | { readonly kind: 'invalid_deck'; readonly errors: readonly string[] };

/**
 * 指定エフェメラル ID のデッキを提出し、サーバー検証する(ADR 0011 #7)。
 * 合法ならデッキ(解決済み Card 配列)を席へ記録し、ready は false へ戻す
 * (デッキ変更後に再 ready を要求する安全側)。不正デッキ・未知 ID・開始済みは
 * エラー値で返す。
 */
export function submitDeck(
  state: RoomState,
  ephemeralId: string,
  deckIds: readonly string[]
): Result<RoomState, SubmitDeckError> {
  if (state.phase === 'started') {
    return err({ kind: 'already_started' });
  }
  const role = roleOf(state, ephemeralId);
  if (role === null) {
    return err({ kind: 'unknown_player' });
  }
  const validation = validateDeck(deckIds);
  if (!validation.valid) {
    return err({ kind: 'invalid_deck', errors: validation.errors });
  }
  const slot = state.slots[role] as Slot;
  const slots = withSlot(state.slots, role, { ...slot, deck: validation.deck, ready: false });
  return ok({ ...state, slots });
}

/** markReady のエラー。 */
export type MarkReadyError = 'unknown_player' | 'no_deck' | 'already_started';

/**
 * 指定エフェメラル ID を ready にする(ADR 0011 #7 のマッチ開始合意)。
 * デッキ未提出での ready は no_deck で弾く(合法デッキ提出後にのみ ready 可)。
 */
export function markReady(
  state: RoomState,
  ephemeralId: string
): Result<RoomState, MarkReadyError> {
  if (state.phase === 'started') {
    return err('already_started');
  }
  const role = roleOf(state, ephemeralId);
  if (role === null) {
    return err('unknown_player');
  }
  const slot = state.slots[role] as Slot;
  if (slot.deck === null) {
    return err('no_deck');
  }
  const slots = withSlot(state.slots, role, { ...slot, ready: true });
  return ok({ ...state, slots });
}

/** 両席が埋まり・両者 ready・両者デッキ提出済みなら開始可。 */
export function canStart(state: RoomState): boolean {
  if (state.phase !== 'full') {
    return false;
  }
  const [a, b] = state.slots;
  return a !== null && b !== null && a.ready && b.ready && a.deck !== null && b.deck !== null;
}

/** tryStart のエラー。 */
export type StartError = 'not_ready';

/** tryStart の成功時の戻り。開始後 state と、エンジン生成に使う MatchConfig。 */
export interface StartResult {
  readonly state: RoomState;
  readonly config: MatchConfig;
  /** role 0 / role 1 のエフェメラル ID(matchStart 配信時の selfId/opponentId 解決に使う)。 */
  readonly playerIds: readonly [string, string];
}

/** MatchConfig 組み立てのオプション。masterSeed は DO が乱数源から生成して注入する。 */
export interface StartOptions {
  /** 権威マスター seed(DO が crypto/Math.random で生成して渡す, ADR 0011 #7/#13)。 */
  readonly masterSeed: number;
  /** 初期 HP(省略時 engine 既定 80, ADR 0010 #10)。 */
  readonly maxHp?: number;
  /** 制限時間ミリ秒(省略時 engine 既定 120000, ADR 0010 #10)。 */
  readonly timeLimitMs?: number;
}

/**
 * 両者 ready かつ両デッキ合法ならマッチ開始の構成を作る(ADR 0011 #7)。
 *
 * masterSeed は外部(DO)が生成して注入する。ここはその seed と両席のデッキを
 * MatchConfig へ詰めるだけの純関数で、乱数源を持たない(純粋性, ADR 0011 #7/#13)。
 * 開始可能でなければ not_ready をエラー値で返す。
 */
export function tryStart(state: RoomState, options: StartOptions): Result<StartResult, StartError> {
  if (!canStart(state)) {
    return err('not_ready');
  }
  // canStart が true の時点で両席・両デッキは非 null。
  const a = state.slots[0] as Slot;
  const b = state.slots[1] as Slot;
  const config = buildMatchConfig(
    { id: a.ephemeralId, deck: a.deck as readonly Card[] },
    { id: b.ephemeralId, deck: b.deck as readonly Card[] },
    options
  );
  return ok({
    state: { ...state, phase: 'started' },
    config,
    playerIds: [a.ephemeralId, b.ephemeralId],
  });
}

/**
 * 決着後、同じ相手・同じルームで再戦するためにルームを巻き戻す(ADR 0011 #17)。
 * 両席のデッキ(直前のマッチで検証済み)はそのまま引き継ぎ、ready を立てて phase を 'full' へ
 * 戻す。呼び出し側(DO)は両者の再戦合意が揃った時点でのみこれを呼び、直後に必ず tryStart する
 * 契約(合意が揃った時点で canStart は真になる)。
 */
export function resetForRematch(state: RoomState): RoomState {
  const readySlot = (slot: Slot | null): Slot | null =>
    slot === null ? null : { ...slot, ready: true };
  const slots: readonly [Slot | null, Slot | null] = [
    readySlot(state.slots[0]),
    readySlot(state.slots[1]),
  ];
  return { ...state, slots, phase: 'full' };
}

/**
 * 両プレイヤー(id + deck)と options(masterSeed/maxHp/timeLimitMs)から MatchConfig を
 * 組み立てる純関数(ADR 0011 #7)。masterSeed の生成自体はここではしない。
 * 省略可能な maxHp/timeLimitMs は engine 既定へ倒す。
 */
export function buildMatchConfig(
  player0: { readonly id: string; readonly deck: readonly Card[] },
  player1: { readonly id: string; readonly deck: readonly Card[] },
  options: StartOptions
): MatchConfig {
  return {
    players: [
      { id: player0.id, deck: player0.deck },
      { id: player1.id, deck: player1.deck },
    ],
    options: {
      masterSeed: options.masterSeed,
      maxHp: options.maxHp ?? MATCH_DEFAULT_HP,
      timeLimitMs: options.timeLimitMs ?? MATCH_DEFAULT_TIME_LIMIT_MS,
    },
  };
}

/** エフェメラル ID から role を引く(在席しなければ null)。 */
export function roleOf(state: RoomState, ephemeralId: string): SlotRole | null {
  if (state.slots[0]?.ephemeralId === ephemeralId) {
    return 0;
  }
  if (state.slots[1]?.ephemeralId === ephemeralId) {
    return 1;
  }
  return null;
}

/** slots の 1 席だけ差し替えた新しいタプルを返す(不変更新)。 */
function withSlot(
  slots: readonly [Slot | null, Slot | null],
  role: SlotRole,
  slot: Slot | null
): readonly [Slot | null, Slot | null] {
  return role === 0 ? [slot, slots[1]] : [slots[0], slot];
}
