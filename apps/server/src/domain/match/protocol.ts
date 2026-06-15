/**
 * 対戦 WebSocket メッセージのプロトコル(B1 + B2, ADR 0011 #2/#6/#7/#10)。
 *
 * 純データの型定義のみ(Hono/Workers 非依存, ADR 0004)。DO(lib)と web が同じ語彙で
 * 通信するための契約。B1 は「ルームに繋がる → デッキ提出 → 検証 → seed 配布 → matchStart」、
 * B2 は「打鍵ストリーム(input)→ サーバー権威実行 → 状態デルタ(state, 10Hz)→ 終了
 * (matchEnd)」を定義する。予測/和解/再接続(B3)のメッセージはここに含めない(範囲外)。
 *
 * 受信側が判別共用体として `type` で分岐できるよう、すべてのメッセージは `type` を持つ。
 */

import type { InputCommand, StatePayload } from './session.ts';

export type { InputCommand, StatePayload } from './session.ts';

/** client → server のメッセージ(B1 + B2)。 */
export type ClientMessage =
  /** ルームへ参加する(コードは接続 URL で渡すため本文では任意・将来拡張用)。 */
  | { readonly type: 'join'; readonly code?: string }
  /** デッキ(カード ID 配列)を提出してサーバー検証を依頼する。 */
  | { readonly type: 'submitDeck'; readonly deckIds: readonly string[] }
  /** マッチ開始に同意(ready)する。 */
  | { readonly type: 'ready' }
  /**
   * 打鍵ストリーム(B2, ADR 0011 #2)。約 30〜50ms フレームでバッチした
   * 入力コマンド列を送る。サーバーが権威実行し、各 atMs を受信時刻でクランプする。
   */
  | { readonly type: 'input'; readonly commands: readonly InputCommand[] };

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
  /**
   * 状態デルタ(B2, 下り 10Hz, ADR 0008/0011 #2)。視点別の入力軸 snapshot + 時間軸
   * timers + outcome をまとめて push する。相手の個別打鍵は送らず意味のある変化のみ。
   */
  | { readonly type: 'state'; readonly payload: StatePayload }
  /**
   * マッチ終了(B2, 終了判定の権威 = サーバー, ADR 0011 #10/#12)。撃破・時間切れ・放棄の
   * いずれでも、サーバーが権威で決着を確定した時点で 1 度だけ送る。outcome は視点別。
   */
  | {
      readonly type: 'matchEnd';
      readonly outcome: ServerOutcome;
      readonly result: { readonly winnerId: string | null; readonly endReason: string };
    }
  /** エラー(不正デッキ・満室・未知コード等)。message は人間可読の理由。 */
  | { readonly type: 'error'; readonly message: string };

/** matchEnd の視点別結果(ADR 0011 #12)。 */
export type ServerOutcome = 'win' | 'lose' | 'draw' | 'forfeit';

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
    case 'input': {
      const commands = parseInputCommands(msg.commands);
      return commands === null ? null : { type: 'input', commands };
    }
    default:
      return null;
  }
}

/** input の commands 配列を検証する(不正要素が 1 つでもあれば null)。 */
function parseInputCommands(raw: unknown): readonly InputCommand[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: InputCommand[] = [];
  for (const item of raw) {
    const cmd = parseInputCommand(item);
    if (cmd === null) {
      return null;
    }
    out.push(cmd);
  }
  return out;
}

/** 1 入力コマンドを検証する(select / press のみ。atMs は有限数)。 */
function parseInputCommand(raw: unknown): InputCommand | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.atMs !== 'number' || !Number.isFinite(c.atMs)) {
    return null;
  }
  if (c.kind === 'select') {
    return typeof c.handIndex === 'number' && Number.isInteger(c.handIndex)
      ? { kind: 'select', handIndex: c.handIndex, atMs: c.atMs }
      : null;
  }
  if (c.kind === 'press') {
    return typeof c.key === 'string' ? { kind: 'press', key: c.key, atMs: c.atMs } : null;
  }
  return null;
}
