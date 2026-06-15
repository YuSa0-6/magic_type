/**
 * Hono アプリのエントリポイント(Cloudflare Workers 上で動作)。
 *
 * `/api/*` のみを Worker が処理する(wrangler.jsonc の run_worker_first 設定)。
 * それ以外のパスは Workers Assets が Svelte SPA(Vite ビルド成果物 dist)を配信するため、
 * ここでルーティングする必要はない。
 *
 * 各機能のルートは routes/ 以下のサブルーターで定義し、
 * app.route() でマウントする(Hono 公式の "Building a larger application" パターン)。
 *
 * Durable Object クラス(MatchRoom)はここで再 export する。wrangler は
 * エントリモジュールの named export から DO クラスを解決する(ADR 0011 #5)。
 */

import { Hono } from 'hono';
import healthRoutes from './routes/health.ts';
import matchRoutes from './routes/match.ts';
import type { Env } from './lib/match-room.ts';

// Durable Object クラスを Worker エントリから export する(wrangler の DO バインディング解決用)。
export { MatchRoom } from './lib/match-room.ts';

const app = new Hono<{ Bindings: Env }>();

app.route('/api', healthRoutes);
app.route('/api', matchRoutes);

export default app;
