/**
 * Hono アプリのエントリポイント(Cloudflare Workers 上で動作)。
 *
 * `/api/*` のみを Worker が処理する(wrangler.jsonc の run_worker_first 設定)。
 * それ以外のパスは Workers Assets が Svelte SPA(Vite ビルド成果物 dist)を配信するため、
 * ここでルーティングする必要はない。
 *
 * 各機能のルートは routes/ 以下のサブルーターで定義し、
 * app.route() でマウントする(Hono 公式の "Building a larger application" パターン)。
 */

import { Hono } from 'hono';
import healthRoutes from './routes/health.ts';

const app = new Hono();

app.route('/api', healthRoutes);

export default app;
