import { describe, it, expect } from 'vitest';
import health from './health.ts';

// Workers ランタイムを起動せず、Hono の app.request でハンドラ単体を検証する。
describe('health ルート', () => {
  it('GET /health は { ok: true } を返す', async () => {
    const res = await health.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
