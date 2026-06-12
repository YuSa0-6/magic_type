/**
 * Hono アプリのエントリポイント(Cloudflare Workers 上で動作)。
 *
 * `/api/*` のみを Worker が処理する(wrangler.jsonc の run_worker_first 設定)。
 * それ以外のパスは Workers Assets が Svelte SPA(Vite ビルド成果物 dist)を配信するため、
 * ここでルーティングする必要はない。
 */

import { Hono } from 'hono';

const app = new Hono();

// 健全性確認エンドポイント。死活監視や疎通確認に使う。
app.get('/api/health', (c) => c.json({ ok: true }));

export default app;
