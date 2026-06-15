/**
 * 対戦 WebSocket メッセージのプロトコル(B1 サブセット, ADR 0011 #6/#7)。
 *
 * 純データの型定義のみ(Hono/Workers 非依存, ADR 0004)。DO(lib)と web が同じ語彙で
 * 通信するための契約。B1 は「ルームに繋がる → デッキ提出 → 検証 → seed 配布 → matchStart」
 * までのメッセージのみを定義する。打鍵の権威ループ(B2)・予測/和解/再接続(B3)の
 * メッセージはここに含めない(範囲外)。
 *
 * 受信側が判別共用体として `type` で分岐できるよう、すべてのメッセージは `type` を持つ。
 */

/** client → server のメッセージ(B1)。 */
export type ClientMessage =
  /** ルームへ参加する(コードは接続 URL で渡すため本文では任意・将来拡張用)。 */
  | { readonly type: 'join'; readonly code?: string }
  /** デッキ(カード ID 配列)を提出してサーバー検証を依頼する。 */
  | { readonly type: 'submitDeck'; readonly deckIds: readonly string[] }
  /** マッチ開始に同意(ready)する。 */
  | { readonly type: 'ready' };

/** server → client のメッセージ(B1)。 */
export type ServerMessage =
  /** 参加受理。発行したエフェメラル ID と席(role)を通知する。 */
  | { readonly type: 'joined'; readonly ephemeralId: string; readonly role: 0 | 1 }
  /** 相手が参加した(満室になった)ことを既存プレイヤーへ通知する。 */
  | { readonly type: 'opponentJoined' }
  /** デッキ提出が受理された(サーバー検証 OK)。 */
  | { readonly type: 'deckAccepted' }
  /**
   * マッチ開始。権威マスター seed と自分/相手のエフェメラル ID を配る(ADR 0011 #7)。
   * 以降の権威ループ(B2)はこの seed で決定論初期化される。
   */
  | {
      readonly type: 'matchStart';
      readonly seed: number;
      readonly selfId: string;
      readonly opponentId: string;
    }
  /** エラー(不正デッキ・満室・未知コード等)。message は人間可読の理由。 */
  | { readonly type: 'error'; readonly message: string };

/** unknown を ClientMessage として安全に解釈する(JSON.parse 後の検証)。 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case 'join':
      return msg.code === undefined || typeof msg.code === 'string'
        ? { type: 'join', code: msg.code as string | undefined }
        : null;
    case 'submitDeck':
      return Array.isArray(msg.deckIds) && msg.deckIds.every((x) => typeof x === 'string')
        ? { type: 'submitDeck', deckIds: msg.deckIds as string[] }
        : null;
    case 'ready':
      return { type: 'ready' };
    default:
      return null;
  }
}
