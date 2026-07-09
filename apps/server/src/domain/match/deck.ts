/**
 * サーバー側デッキ検証(ADR 0011 #7)。
 *
 * デッキ(カード ID 配列)が対戦の合法デッキ(15 枚・同種最大 2・実在カードのみ)かを
 * 検証し、Card 配列へ解決する純関数群。判定の権威はサーバーに置く(ADR 0011 #1/#7)ため、
 * web の `deck-storage`(クライアント検証)とは独立にサーバー側でも同じ規則を持つ。
 * これによりクライアントの自己申告(不正デッキ)を弾ける。
 *
 * カードプールは engine の `CARDS`(純攻撃 10)+ `EFFECT_CARDS`(効果 6)+ `QUICK_CARDS`(クイック 5)
 * を正とする。web の `deck-storage` プールと同じ全集合に揃える(クライアント/サーバーの乖離防止)。
 * Hono / Cloudflare Workers のランタイム API には依存しない純 TS(ADR 0004)。
 */

import { CARDS, EFFECT_CARDS, QUICK_CARDS, type Card } from '../engine/index.ts';

/** デッキの規定枚数(ADR 0010/0011)。 */
export const DECK_SIZE = 15;
/** 同種カードの上限枚数(ADR 0010/0011)。 */
export const MAX_PER_CARD = 2;

/** カードプール(純攻撃 10 + 効果 6 + クイック 5)。サーバーが認める実在カードの全集合。 */
export const CARD_POOL: readonly Card[] = [...CARDS, ...EFFECT_CARDS, ...QUICK_CARDS];

const POOL_BY_ID: ReadonlyMap<string, Card> = new Map(CARD_POOL.map((c) => [c.id, c]));

/** カード ID から Card を引く(プールに無ければ undefined)。 */
export function cardById(id: string): Card | undefined {
  return POOL_BY_ID.get(id);
}

/**
 * デッキ検証の結果型(例外ではなく結果値で返す, ADR 0011 #7)。
 * valid なら deck に解決済み Card 配列が入り、errors は空。
 * invalid なら errors に違反理由が入り、deck は null。
 */
export type DeckValidation =
  | { readonly valid: true; readonly deck: readonly Card[] }
  | { readonly valid: false; readonly errors: readonly string[] };

/**
 * カード ID 配列を検証して Card 配列へ解決する(15 枚・同種最大 2・実在カード, ADR 0011 #7)。
 *
 * 合法なら解決済み Card 配列を valid 結果として返す(MatchEngine の deck にそのまま渡せる)。
 * 不正(枚数違い・不明 ID・同種超過)はエラー値で返す(例外を投げない)。
 */
export function validateDeck(cardIds: readonly string[]): DeckValidation {
  const errors: string[] = [];

  if (cardIds.length !== DECK_SIZE) {
    errors.push(`デッキは${DECK_SIZE}枚にしてください(現在 ${cardIds.length}枚)`);
  }

  const counts = new Map<string, number>();
  for (const id of cardIds) {
    if (!POOL_BY_ID.has(id)) {
      errors.push(`不明なカードが含まれています: ${id}`);
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > MAX_PER_CARD) {
      const name = POOL_BY_ID.get(id)?.name ?? id;
      errors.push(`${name}が${count}枚あります(同種は最大${MAX_PER_CARD}枚)`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  // 全 ID が実在することは上のループで確認済みなので非 null アサーションは不要。
  return { valid: true, deck: cardIds.map((id) => POOL_BY_ID.get(id) as Card) };
}
