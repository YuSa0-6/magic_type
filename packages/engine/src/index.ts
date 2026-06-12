/**
 * @magic/engine のバレル。純TSドメイン層の公開API。
 * UI・サーバーはここ('@magic/engine')経由でのみエンジンを参照する。
 */

export type {
  PressResult,
  BattleSnapshot,
  BattleEvent,
  CardStat,
  BattleStats,
} from './battle.ts';
export { BattleEngine } from './battle.ts';

export type { Card } from './cards.ts';
export { CARDS, STARTER_DECK } from './cards.ts';

export type { KeyResult } from './romaji/session.ts';
export { TypingSession } from './romaji/session.ts';
