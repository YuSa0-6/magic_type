# 0003. Hono + Cloudflare Workers へホスティングを移行する

- ステータス: 承認
- 日付: 2026-06-12
- 関連: ADR 0002(純TSエンジン分離)

## 文脈

ベース実装は「完全クライアントの静的サイト。バックエンドは対戦モード着手時に
別途設計」という方針で、GitHub Pages に自動デプロイしていた。

その後、サーバーサイドの土台として Hono を導入したいという要望が確定した。
画面遷移自体はハッシュルーティング(クライアントサイド)で完結しており、現時点で
必須のAPIはないが、対戦モード(オンラインPvP)ではリアルタイム通信・マッチング・
判定の権威をサーバーに置く構想があり、その土台を先に立てる判断である。

検討した配置:

- **A. Hono を Cloudflare Workers に置き、SPA も Workers Assets で配信**
- **B. @hono/node-server で自前ホスト(Render/Fly/VPS等)**: 運用負荷が増える
- **C. GitHub Pages 継続 + API が必要になったら別途**: Hono 導入を先送り

## 決定

**A を採用する。** GitHub Pages を廃止し、Cloudflare Workers へ移行する。

- Hono アプリが `/api/*` を処理し、それ以外は Workers Assets が
  Svelte SPA(Vite ビルド成果物)を配信する
- デプロイは wrangler を使い、CI(GitHub Actions)の main マージ時に実行する
- Vite の `base` は `/magic/`(Pages のリポジトリパス)から `/` に変更する

## 結果

### 良い点

- Hono の本来の実行環境であり、エッジ配信・無料枠・運用レスの利点を保ったまま
  サーバーコードの置き場ができる
- 対戦モードで必要になる WebSocket / Durable Objects へ同一プラットフォームで
  地続きに進める(ADR 0002 の純TSエンジンをサーバー側の判定の権威として
  持ち込む構想とも整合)
- フロントとAPIが同一オリジンになり、CORS を考えずに済む

### トレードオフ

- GitHub だけで完結していたデプロイが Cloudflare アカウントと
  シークレット(CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)の管理を要する
- 静的配信のみだった構成にサーバーコードと wrangler 設定が加わり、
  リポジトリの複雑性が一段増える
- 現時点の API は健全性確認程度であり、当面はほぼ静的配信のためだけに
  Workers を使う(将来への先行投資)
