import { describe, it, expect } from 'vitest';
import app from './index.ts';

// Workers ランタイムを起動せず、Hono の app.request でハンドラ単体を検証する。
describe('Hono server', () => {
  it('GET /api/health は { ok: true } を返す', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
