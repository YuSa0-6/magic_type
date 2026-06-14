/**
 * 判定エンジンのバレル。サーバーのドメイン層の公開API。
 * server は相対 import で、web は '@magic/server/engine' 経由でのみ参照する。
 */

export type {
  PressResult,
  BattleTimers,
  BattleState,
  BattleEvent,
  CardStat,
  BattleStats,
} from './battle.ts';
export { BattleEngine } from './battle.ts';

export type { Card } from './cards.ts';
export { CARDS, STARTER_DECK, EFFECT_CARDS } from './cards.ts';

export type { Effect } from './effects.ts';

export type { KeyResult } from './romaji/session.ts';
export { TypingSession } from './romaji/session.ts';
