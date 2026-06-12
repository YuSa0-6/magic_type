# マジックタイピングバトル

日本語タイピングとカードゲームを組み合わせたブラウザ対戦ゲームです。プレイヤーはカードを選んでお題をタイピングし、詠唱を完了させることでカード効果を発動させて相手にダメージを与えます。正確かつ素早いタイピングが勝敗を左右します。

## 技術スタック

| ツール / ライブラリ               | バージョン管理                             |
| --------------------------------- | ------------------------------------------ |
| mise                              | ツールバージョン管理（`.mise.toml`）       |
| pnpm                              | パッケージマネージャ                       |
| Svelte 5 + TypeScript + Vite      | フロントエンドフレームワーク＋ビルドツール |
| Hono                              | サーバー（`/api/*` を処理）                |
| Cloudflare Workers + wrangler     | ホスティング（SPA 静的配信 + Worker）      |
| Vitest                            | ユニットテスト                             |
| Oxlint                            | リンター                                   |
| Prettier + prettier-plugin-svelte | コードフォーマッター                       |

## 開発コマンド

```bash
# 依存関係のインストール
pnpm install

# 開発サーバー起動（UI 開発用 Vite）
pnpm dev

# ビルド
pnpm build

# ビルドのプレビュー（Vite）
pnpm preview

# ローカルで Worker + 静的配信を確認（要 pnpm build 済みの dist）
pnpm dev:server

# Cloudflare Workers へデプロイ（build + wrangler deploy、通常は CI から実行）
pnpm deploy

# テスト実行
pnpm test

# リント
pnpm lint

# フォーマット（自動修正）
pnpm format

# フォーマットチェック（CI用）
pnpm format:check
```
