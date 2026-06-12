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
| pnpm workspace                    | モノレポ（apps/_・packages/_）             |

## リポジトリ構成

pnpm workspace によるモノレポです。ADR 0002 のドメイン分離をパッケージ境界に昇格しています。

```
magic/
├── packages/
│   └── engine/   # @magic/engine — 純TSドメイン層（TypingSession / BattleEngine / CARDS 等）
└── apps/
    ├── web/      # @magic/web — Svelte SPA（@magic/engine を参照）
    └── server/   # @magic/server — Hono on Cloudflare Workers（/api/* を処理し dist を静的配信）
```

エンジンは TS ソースのまま `@magic/engine` として公開（`exports` → `src/index.ts`）し、Vite / Vitest / wrangler が直接解決します。

## 開発コマンド

ルートの scripts は pnpm workspace を再帰実行します。

```bash
# 依存関係のインストール
pnpm install

# 開発サーバー起動（UI 開発用 Vite）
pnpm dev

# ビルド
pnpm build

# ビルドのプレビュー（Vite）
pnpm --filter @magic/web preview

# ローカルで Worker + 静的配信を確認（要 pnpm build 済みの apps/web/dist）
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
