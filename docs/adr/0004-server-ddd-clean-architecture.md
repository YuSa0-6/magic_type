# 0004. サーバー(Hono)を DDD + クリーンアーキテクチャで構成する

- ステータス: 承認
- 日付: 2026-06-12
- 関連: ADR 0002(純TSエンジン分離)、ADR 0003(Hono + Cloudflare Workers)

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

- **A. engine を共有ドメイン中核とする層構成**: server/domain にはサーバー固有の
  概念(ルーム、マッチング等)だけを置き、ゲームルールは engine を直接参照する
- **B. server に独立した domain 層を完結させる**: engine は外部ライブラリ扱いで
  infrastructure 経由で利用する。層の純粋性は上がるがラッパーコードが増え、
  ルールの二重化を招きやすい
- **C. 層を決めず必要になってから考える**: 最初の本物の API 実装時に
  リファクタリングコストを払う

## 決定

**A を採用する。** `apps/server/src` を次の層で構成する:

```
apps/server/src/
  domain/           # サーバー固有のドメイン(ルーム、マッチング、プレイヤー等)
  application/      # ユースケース + ポート(リポジトリ等の interface)
  infrastructure/   # ポートの実装(D1 / KV / Durable Objects 等)
  presentation/     # Hono のルート定義・ハンドラ・ミドルウェア(HTTP の関心事のみ)
  index.ts          # composition root(依存の組み立てと Hono app の export)
```

### 依存ルール

- 依存方向は `presentation → application → domain` の一方向とする
- `infrastructure` は `application` が定義するポート(interface)を実装する。
  逆向き(application が infrastructure の具象を import)は禁止
- Hono の型・API が現れてよいのは `presentation` と `index.ts` のみ。
  `application` 以深は Hono にも Cloudflare Workers のランタイム API にも
  依存しない純 TypeScript とする
- ユースケースが必要とするランタイム機能(ストレージ、時刻、乱数等)は
  ポートとして抽象化し、composition root で実装を注入する

### engine との関係

- タイピング判定・バトルのルールは `@magic/engine` を唯一の正とし、
  `server/domain` に同種のロジックを書かない(二重化の禁止)
- `domain` と `application` は engine を直接 import してよい。engine は
  ADR 0002 によりフレームワーク非依存の純 TS であり、ドメイン中核を
  ドメイン層から参照することは依存ルールに反しない
- サーバー権威の判定(対戦モード)は、engine をユースケースから駆動する形で
  実装する

### 適用タイミング

ディレクトリと実装は今は作らない。`/api/health` だけの現段階で空フォルダを
並べても見通しが悪くなるだけのため、**最初の本物の API(対戦モードの
マッチング等)を実装する PR で本 ADR の構成を導入する**。それまでの間、
`index.ts` への直書きで増やしてよいのは health 同等の自明なエンドポイント
のみとする。

## 結果

### 良い点

- 対戦モード着手時に、層の置き場と依存ルールを議論し直さずに済む
- ユースケース以深が純 TS のため、Workers ランタイムなしで Vitest により
  テストできる(ADR 0002 と同じ利点をサーバー側でも得る)
- engine を共有ドメイン中核と明文化したことで、クライアントとサーバーで
  判定ロジックが分岐するリスクを塞ぐ

### トレードオフ

- 小規模 API には層が過剰になる。自明なエンドポイントまでユースケース化する
  強制はしない(適用タイミングの節で逃げ道を定義)
- ポート定義と composition root の組み立てという定型コードが増える
- B 案に比べ、domain が engine という外部パッケージに直接依存するため、
  engine の破壊的変更がサーバーのドメイン層に直接波及する
