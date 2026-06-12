# 0004. サーバー(Hono)を DDD ベースの層構成にする

- ステータス: 承認(engine の配置に関する記述は ADR 0005 により上書き —
  engine は独立パッケージではなく `domain/engine/` に置かれる)
- 日付: 2026-06-12
- 関連: ADR 0002(純TSエンジン分離)、ADR 0003(Hono + Cloudflare Workers)
- 参考: [Hono マイベストプラクティス](https://zenn.dev/yodaka/articles/ad49f29a54ceba)

## 文脈

ADR 0003 で Hono + Cloudflare Workers のサーバーを立てたが、現状の API は
`/api/health` のみで、`apps/server/src/index.ts` にルートを直書きしている。
対戦モード(オンラインPvP)ではマッチング・ルーム管理・サーバー権威の判定が
加わる構想があり、その際に場当たり的にルートへロジックを書き足すと
テスト不能な Worker コードが育つリスクがある。先に層の構成と依存ルールを
決めておきたい。

前提として、このリポジトリには既にドメイン層が存在する。ADR 0002 で分離した
`packages/engine` がそれであり、タイピング判定・バトルルールの唯一の正である。
サーバーの DDD 化は「ゼロから全層を作る」ことではなく、engine をドメイン中核
として参照する形でサーバー固有の層を組むことを意味する。

検討した構成:

- **A. 教科書的クリーンアーキテクチャ4層**
  (domain / application / infrastructure / presentation + composition root):
  依存ルールは最も厳格だが、ポート定義と DI の定型コードが多く、
  現規模には過剰
- **B. Hono コミュニティの実践型レイアウト**(参考記事):
  domain / lib / routes / middleware / schema / utils。関数と定数中心で
  クラスを使わず、ルーターは機能ごとのサブルーターに分割する
- **C. 層を決めず必要になってから考える**: 最初の本物の API 実装時に
  リファクタリングコストを払う

## 決定

**B を採用する。** `apps/server/src` を次の層で構成する:

```
apps/server/src/
  domain/           # サーバー固有のドメインロジック(関数と定数中心、クラス不使用)
  lib/              # 外部 SDK・ライブラリの薄いラッパー(将来: D1 / KV / DO 等)
  routes/           # 機能ごとの Hono サブルーター(HTTP の関心事のみ)
  middleware/       # ロガー・認証等(必要になったら)
  schema/           # Zod によるリクエスト/レスポンススキーマ(リソースごとに分割)
  utils/            # 汎用関数
  index.ts          # エントリポイント(サブルーターのマウントと app の export)
```

### 依存ルール

- `routes` → `domain` の一方向。domain から routes を import しない
- Hono の型・API が現れてよいのは `routes` / `middleware` / `index.ts` のみ。
  `domain` は Hono にも Cloudflare Workers のランタイム API にも依存しない
  純 TypeScript とし、Vitest で Worker ランタイムなしにテストする
- 外部 SDK・ランタイム依存(ストレージ、外部 API 等)は `lib` のラッパーに
  閉じ込め、domain には持ち込まない
- 各ルートファイルは自分の `Hono` インスタンスを作って export し、
  `index.ts` が `app.route()` でマウントする(Hono 公式の
  "Building a larger application" パターン)

### engine との関係

- タイピング判定・バトルのルールは `@magic/engine` を唯一の正とし、
  `server/domain` に同種のロジックを書かない(二重化の禁止)
- `domain` は engine を直接 import してよい。engine は ADR 0002 により
  フレームワーク非依存の純 TS であり、ドメイン中核をドメイン層から
  参照することは依存ルールに反しない
- サーバー権威の判定(対戦モード)は、engine を domain から駆動する形で
  実装する

### 適用タイミング

本 ADR と同じ PR で `routes/` を導入し、`/api/health` をサブルーターへ
載せ替えて動く見本にする。`middleware` / `schema` / `lib` / `utils` などの
ディレクトリは中身が生まれるときに作り、空フォルダは置かない。

## 結果

### 良い点

- 対戦モード着手時に、層の置き場と依存ルールを議論し直さずに済む
- domain が純 TS のため、Workers ランタイムなしで Vitest によりテストできる
  (ADR 0002 と同じ利点をサーバー側でも得る)
- engine を共有ドメイン中核と明文化したことで、クライアントとサーバーで
  判定ロジックが分岐するリスクを塞ぐ
- A 案に比べ定型コード(ポート定義・DI の組み立て)が少なく、現規模に見合う

### トレードオフ

- A 案のような強制力のある依存逆転(interface 越しの注入)はないため、
  依存ルールはレビューで守る運用になる
- domain が engine という外部パッケージに直接依存するため、engine の
  破壊的変更がサーバーのドメイン層に直接波及する
- 将来ユースケース層が必要な複雑さ(トランザクション境界、複数ストレージの
  協調等)が出てきた場合は、application 層の追加を別 ADR で検討する
