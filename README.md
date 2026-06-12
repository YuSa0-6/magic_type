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

pnpm workspace によるモノレポです。ADR 0002 のドメイン分離をパッケージ境界に昇格し、ADR 0004 で `@magic/engine` を製品全体の唯一のドメイン層と定めています。

```
magic/
├── packages/
│   └── engine/   # @magic/engine — 製品全体の純TSドメイン層（唯一の正。TypingSession / BattleEngine / CARDS 等）
└── apps/
    ├── web/      # @magic/web — Svelte SPA（@magic/engine を参照）
    └── server/   # @magic/server — Hono on Cloudflare Workers（routes/ サブルーター構成。/api/* を処理し dist を静的配信）
```

エンジンは TS ソースのまま `@magic/engine` として公開（`exports` → `src/index.ts`）し、Vite / Vitest / wrangler が直接解決します。ビジネスルールはすべて engine に置き、web / server はそれぞれ表示と HTTP の変換に徹します（ADR 0004 の依存ルール）。

## セットアップ

依存は mise が `.mise.toml` の定義どおりに Node / pnpm を固定インストールします。

### macOS / Linux

```bash
curl https://mise.run | sh   # mise 未導入の場合
mise install
pnpm install
```

### Windows

mise は Windows をネイティブサポートしています（WSL 不要）。PowerShell で:

```powershell
winget install jdx.mise   # mise 未導入の場合
mise install
pnpm install
```

> シェルへの mise の有効化（PATH 設定）は [mise 公式ドキュメント](https://mise.jdx.dev/getting-started.html) を参照してください。以降のコマンドは OS 共通です。

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
