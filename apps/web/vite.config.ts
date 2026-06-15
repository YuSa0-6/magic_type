import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// 開発時、Vite(5173)から `/api/*`(HTTP + WebSocket)を wrangler dev(8787)へプロキシする。
// これで web の WS トランスポートは本番(Workers が同一オリジンで /api と SPA を配信)と
// 同じ「同一オリジンの /api」で書け、開発でも 2 タブのオンライン対戦を試せる(ADR 0011 #5/#6)。
// 本番ビルド(vite build)はこの設定を使わない(同一オリジンで完結するため不要)。
export default defineConfig({
  base: '/',
  plugins: [svelte()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
