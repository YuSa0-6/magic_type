/**
 * デッキの構築規則・検証・永続化(ADR 0011 #7)。
 *
 * デッキは localStorage に保存し、対戦開始時にサーバーへ送ってサーバーが合法性を
 * 検証する(15 枚・同種最大 2・実在カード)のが本来の流れ(ADR 0011 #7)。v1 は
 * オフライン(対ボット)なのでサーバーは無く、ここで同じ規則をクライアント検証する。
 *
 * 保存形式はカード ID の配列(`string[]`)。Card オブジェクトそのものは保存せず、
 * 読み込み時に CARDS / EFFECT_CARDS / QUICK_CARDS から引き直す(カード定義の変更に追従するため)。
 * これは非コンポーネントのドメイン隣接ロジックなので lib に置く(ADR 0006)。
 */

import { CARDS, EFFECT_CARDS, QUICK_CARDS, STARTER_DECK, type Card } from '@magic/server/engine';

/** デッキの規定枚数(ADR 0010/0011, CONTEXT.md「デッキ」)。 */
export const DECK_SIZE = 15;
/** 同種カードの上限枚数。 */
export const MAX_PER_CARD = 2;

/** localStorage のキー。エフェメラル ID 前提なので 1 デッキのみ保持する(ADR 0011 #7)。 */
const STORAGE_KEY = 'magic:pvp:deck';

/**
 * カードプール(純攻撃 10 + 効果 6 + クイック 5)。ID から Card を引く逆引きにも使う。
 * サーバー側 `match/deck` のプールと同じ全集合に揃える(ADR 0011 #1/#7・乖離防止)。
 */
export const CARD_POOL: readonly Card[] = [...CARDS, ...EFFECT_CARDS, ...QUICK_CARDS];

const POOL_BY_ID: ReadonlyMap<string, Card> = new Map(CARD_POOL.map((c) => [c.id, c]));

/** カード ID から Card を引く(プールに無ければ undefined)。 */
export function cardById(id: string): Card | undefined {
  return POOL_BY_ID.get(id);
}

/** デッキの検証結果。valid なら errors は空。 */
export interface DeckValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * カード ID 配列を検証する(15 枚・同種最大 2・実在カード, ADR 0011 #7)。
 * UI のボタン活性判定とエラー表示の両方からこの 1 関数を使う。
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

  return { valid: errors.length === 0, errors };
}

/** カード ID 配列を Card 配列に解決する(不明 ID は除外)。対戦エンジンへ渡す形。 */
export function resolveDeck(cardIds: readonly string[]): Card[] {
  return cardIds.flatMap((id) => {
    const card = POOL_BY_ID.get(id);
    return card ? [card] : [];
  });
}

/**
 * 保存済みデッキ(カード ID 配列)を読み込む。
 * 未保存・壊れたデータ・不正なデッキは null を返し、呼び出し側が既定デッキへ倒す。
 */
export function loadDeckIds(): string[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // プライベートブラウズ等で localStorage が使えない場合は未保存扱い。
    return null;
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((x): x is string => typeof x === 'string')) {
    return null;
  }
  // 壊れた保存を読み込んで不正なデッキで対戦に入らないよう、ここでも検証する。
  if (!validateDeck(parsed).valid) {
    return null;
  }
  return parsed;
}

/** デッキ(カード ID 配列)を保存する。失敗(容量超過等)は false を返す。 */
export function saveDeckIds(cardIds: readonly string[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cardIds));
    return true;
  } catch {
    return false;
  }
}

/** 既定デッキ(STARTER_DECK)のカード ID 配列。未保存時のフォールバックに使う。 */
export function defaultDeckIds(): string[] {
  return STARTER_DECK.map((c) => c.id);
}

/**
 * 対戦に使うデッキ(Card 配列)を取得する。保存済みが正当ならそれを、無ければ
 * 既定デッキ(STARTER_DECK)を使う。対戦画面はこの 1 関数だけ呼べばよい。
 */
export function loadDeckOrDefault(): Card[] {
  const ids = loadDeckIds() ?? defaultDeckIds();
  return resolveDeck(ids);
}
