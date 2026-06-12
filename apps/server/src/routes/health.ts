/**
 * 健全性確認ルート。
 *
 * 死活監視や疎通確認に使う。
 * パスプレフィックス `/api` は index.ts の app.route() でマウントする。
 */

import { Hono } from 'hono';

const health = new Hono();

health.get('/health', (c) => c.json({ ok: true }));

export default health;
