/**
 * 対戦ドメイン(ルーム / デッキ検証 / プロトコル)のバレル。
 * lib(DO)・routes はここから純 TS のドメインロジックを参照する(ADR 0004)。
 * web には公開しない(@magic/server の export は engine のみ, ADR 0005)。
 */

export {
  DECK_SIZE,
  MAX_PER_CARD,
  CARD_POOL,
  cardById,
  validateDeck,
  type DeckValidation,
} from './deck.ts';

export {
  createRoom,
  join,
  submitDeck,
  markReady,
  canStart,
  tryStart,
  buildMatchConfig,
  roleOf,
  ok,
  err,
  type Result,
  type Slot,
  type SlotRole,
  type RoomPhase,
  type RoomState,
  type JoinError,
  type JoinResult,
  type SubmitDeckError,
  type MarkReadyError,
  type StartError,
  type StartResult,
  type StartOptions,
} from './room.ts';

export {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type ServerOutcome,
  type InputCommand,
  type StatePayload,
} from './protocol.ts';

export { MatchSession } from './session.ts';
