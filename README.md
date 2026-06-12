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

## セットアップ

依存は mise が `.mise.toml` の定義どおりに Node / pnpm を固定インストールします。

### macOS / Linux

```bash
curl https://mise.run | sh   # mise 未導入の場合
mise install
pnpm install
```

### Windows

mise は Windows をネイティブサポートしているため、**WSL は不要**です。PowerShell で以下の手順を実行してください。

#### 1. mise のインストール（未導入の場合）

winget または Scoop のどちらかで導入します。

```powershell
# winget の場合
winget install jdx.mise

# Scoop の場合(シムが自動で PATH に入るため、こちらだと手順2を省略できます)
scoop install mise
```

#### 2. PowerShell への mise の有効化（winget で入れた場合）

PowerShell 起動時に mise が自動で有効になるよう、プロファイルに追記します。

```powershell
# プロファイルの親フォルダがない場合は先に作成
New-Item -ItemType Directory -Force (Split-Path $PROFILE) | Out-Null

# プロファイルに mise のアクティベートを追記
Add-Content $PROFILE '(&mise activate pwsh) | Out-String | Invoke-Expression'
```

追記後、**PowerShell を開き直して**ください。`mise --version` が表示されれば成功です。

> プロファイルの場所や詳細は PowerShell の `about_Profiles`、mise 側の説明は [mise 公式ドキュメント](https://mise.jdx.dev/installing-mise.html) を参照してください。

#### 3. リポジトリの取得とツールのインストール

```powershell
git clone https://github.com/YuSa0-6/magic_type.git
cd magic_type

# .mise.toml に固定された Node / pnpm が自動で入る
mise install

# 依存パッケージのインストール
pnpm install
```

#### 4. 動作確認

```powershell
pnpm dev    # http://localhost:5173 が開ければ環境構築完了
pnpm test   # テストが全件通ることを確認
```

#### うまくいかないとき

- `mise` コマンドが見つからない → PowerShell を開き直す。それでもだめなら手順2のプロファイル追記を確認
- スクリプト実行がブロックされる(実行ポリシーのエラー) → `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行してから PowerShell を開き直す
- `pnpm` が見つからない → リポジトリのフォルダ内で実行しているか確認(`mise install` は `.mise.toml` のあるフォルダで実行する必要があります)

以降の開発コマンドは OS 共通です。

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
