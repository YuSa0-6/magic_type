/**
 * 対戦ルーム関連の Hono サブルーター(HTTP の関心事のみ, ADR 0004)。
 *
 * - `POST /match` : ルームを作成し、参加用のルームコードを発行する(ADR 0011 #6)。
 *   作成側はこのコードを相手に共有し、双方が `GET /match/:code` で WS 接続する。
 * - `GET /match/:code` : WebSocket アップグレードを該当ルームの Durable Object へ
 *   フォワードする(1 マッチ = 1 DO, ADR 0011 #5)。
 *
 * 判定・ルーム状態はすべて DO(lib)+ domain が持つ。ここは「コード発行」と
 * 「DO への fetch フォワード」だけに徹する。`/api` プレフィックスは index.ts でマウントする。
 */

import { Hono } from 'hono';
import type { Env } from '../lib/match-room.ts';

const match = new Hono<{ Bindings: Env }>();

/** ルームコードの文字種(紛らわしい 0/O・1/I を除いた大文字英数字)。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** ルームコードを生成する(暗号乱数で 6 文字)。 */
function generateRoomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * ルームを作成する。コードを発行して返すだけで、DO はまだ起こさない
 * (最初の WS 接続時に idFromName(code) で初めて実体化する)。
 */
match.post('/match', (c) => {
  const code = generateRoomCode();
  return c.json({ code });
});

/**
 * ルームコードへ WebSocket 接続する。コードから DO を引き、Upgrade 付き fetch を
 * フォワードする。作成側・参加側ともこのエンドポイントを使う(ADR 0011 #6)。
 */
match.get('/match/:code', (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('expected websocket upgrade', 426);
  }
  const code = c.req.param('code').toUpperCase();
  // コード文字列から決定論的に DO id を引く(同じコード → 同じ DO = 同じルーム)。
  const id = c.env.MATCH_ROOM.idFromName(code);
  const stub = c.env.MATCH_ROOM.get(id);
  // WS アップグレードをそのまま DO へ渡す(Hono → DO バインディング)。
  return stub.fetch(c.req.raw);
});

export default match;
