# 0012. 対戦 DO の状態永続化(DO Storage)と Alarms 堅牢化

- ステータス: 承認(実装済み: A=storage 永続化 / B=alarms 堅牢化)
- 日付: 2026-06-15
- 関連: ADR 0009(PvP 前方設計 #4 serialize/restore)を実適用、
  ADR 0011(対戦ネットコード #5 1マッチ1DO / #8 切断猶予 / #10 終了専用権威タイマ /
  #11 一時停止中の権威時計凍結)を堅牢化、ADR 0004(サーバー DDD)、ADR 0008(時間軸/入力軸分割)

## 文脈

ADR 0011 で「1 マッチ = 1 Durable Object」(#5)を採り、B1〜B3 は **単一 DO がメモリ常駐で
権威状態(MatchEngine / MatchSession / room / 席)を保持する**前提で実装した。再接続猶予(#8)も
権威時計の凍結(#11)も終了専用の権威タイマ(#10)も、すべて DO のメモリ上の `setInterval` /
`setTimeout` に依存していた。

しかし Durable Object はメモリ常駐を保証しない。**退避(eviction)・再起動・クラッシュ**で
インスタンスが破棄されると、保持していた試合状態と進行中タイマがまるごと消失する。とくに次の
2 つが致命的だった:

- **試合状態の消失**: 退避すると HP・詠唱進捗・効果・rng 消費位置・権威時計が失われ、再接続しても
  試合を継続できない。ADR 0011 #16 は「単一 DO がメモリ常駐で権威状態を保持するため B3 では
  serialize/restore(A3)を使わない(将来 DO 退避が必要になったときに #4 の土台を使う)」と
  明示的に先送りしていた。その「将来」が本 ADR である。
- **タイマの消失**: 退避中は `setInterval` / `setTimeout` が動かない。よって「両者が打鍵を止めて
  制限時間を迎える」「片方が切断したまま猶予を超過する」といった**無通信の終了系イベント**が
  発火せず、試合が決着しないまま宙づりになる(ADR 0011 #10 が予告した「終了専用の権威タイマ」を
  退避耐性のある仕組みで実装する必要がある)。

一方で土台はすでに整っていた: A3 で `MatchEngine.serialize()` / `MatchEngine.restore(config, dto)`
(ADR 0011 #4)を実装・検証済みで、`wrangler.jsonc` の `new_sqlite_classes: ["MatchRoom"]` により
DO は SQLite バックエンドの `ctx.storage` を provisioned 済みだった。これらを活かせば、追加的な
堅牢化として(アクティブ対戦の挙動・ゲームルールを一切変えずに)弱点を塞げる。

## 決定

### (1) ctx.storage へ試合状態をチェックポイント永続化し、起動時に restore する

- **保存対象**(WS 接続自体は揮発なので保存しない。再接続で配り直す):
  `MatchConfig`(players の id+deck・options{masterSeed,maxHp,timeLimitMs})+
  `MatchEngine.serialize()` の DTO + `MatchSession` の権威クロック DTO(authClock 基準・
  pause オフセット・未確定の入力バッファ)+ ルーム/席の権威状態(room phase・各 slot の
  ephemeralId/deck/ready・playerIds・masterSeed・ended・各 role の切断猶予 deadline)。これらを
  `PersistedMatchState` として **1 キー(`match`)へまとめて `ctx.storage.put`** し、部分的に書けて
  壊れた状態を避ける。
- **書き込み契機**(10Hz の全 tick で書くのは避ける): matchStart 時 / **状態が意味的に変わった
  tick(発動・KO・効果適用=権威スナップショットのシグネチャ変化時)** / pause / resume /
  reconnect。matchEnd では永続データを削除して掃除する。シグネチャ差分は
  `MatchSession.stateSignature()`(両陣営の入力軸 + outcome、時間軸 timers は除く)で判定する。
- **復元**: コンストラクタの `ctx.blockConcurrencyWhile` で storage を読み、あれば
  `MatchEngine.restore(config, dto)` → `MatchSession.restore(engine, config, dto)` で権威状態を
  再構築し、room/席の権威状態を復帰する。進行中(非 pause)なら権威 tick を再開、pause 中なら
  tick は止めたまま alarm / reconnect に委ねる。WS が来たら現況 state を配る。これで **DO 退避・
  再起動・クラッシュ後も試合継続**。決着済み(ended)の残骸は復元せず掃除する(二重決着防止)。
- restore 後の authClock / lastConfirmedAtMs / pause オフセットが保存値と一致し、決定論・時計が
  壊れないことを domain テストで検証した(serialize/restore は A3 で検証済みなのでそれに乗る)。

### (2) 猶予/制限時間を ctx.storage の alarm で堅牢化する

- **猶予 forfeit(ADR 0011 #8)と 制限時間 deadline(#10)を `ctx.storage.setAlarm` で予約**し
  `alarm()` で発火する。DO が退避中でも発火するので「無通信で時間切れ/猶予超過しても正しく決着」。
- alarm は単一時刻なので「**現在有効な最も早い deadline**」を持つ: 切断中なら壁時計の grace 期限
  (`disconnectedAt + RECONNECT_GRACE_MS`)、通常は制限時間 deadline(権威時刻
  `startAtMs + timeLimitMs` を実時間へ換算したもの)。状態変化(matchStart / pause / resume /
  reconnect / restore)で最も早い候補へ再スケジュールする。`alarm()` 内では: 猶予超過なら
  forfeit、制限時間超過なら tick で evaluateTimeUp → finalize、決着しなければ次の alarm を再設定する。
- **pause 追従**: 一時停止中(凍結)は authClock が進まないため、制限時間の壁時計換算は null を
  返し alarm に載せない(grace 期限のみ)。resume で凍結ぶん(`pausedOffsetMs`)を畳んでから
  制限時間 deadline を後ろへずらして再予約する(凍結中に旧 deadline で誤発火しない, #11)。

### (3) アクティブ対戦中の 10Hz tick は setInterval を維持し、Hibernation は別途

- **アクティブ対戦中の 10Hz tick は `setInterval` のまま**(alarm は頻度的に不向き)。alarm は
  退避時/疎イベント(無通信での時間切れ・猶予超過)のバックストップに徹する。
- 既存の切断猶予 `setTimeout` は「DO 常駐中のライブ fast-path」として残し、壁時計の grace
  deadline + alarm を退避耐性のあるバックストップとして併用する。forfeit / finalize はどちらも
  冪等(engine は決着後に無視・`ended` ガード)なので、tick / setTimeout / alarm が二重発火しても
  害は無い。
- WebSocket Hibernation(C: `acceptWebSocket` ベースのハイバネーション)・D1/KV(D: 永続
  ランキング等)は本 ADR の範囲外とし、別 ADR で検討する。

## 結果

### 良い点

- **退避耐性**: DO 退避・再起動・クラッシュ後も storage から試合を完全復元でき、再接続で継続できる。
  無通信の終了系イベント(時間切れ・猶予超過)も alarm が退避中に発火して正しく決着する。
- **A3 / provisioned SQLite の活用**: ADR 0009 #4 / 0011 #4 で予約・実装した serialize/restore と、
  `new_sqlite_classes` で用意済みの `ctx.storage` を、追加コストなしに実利用へ転じた。
- **非破壊**: アクティブ対戦の挙動・ゲームルールは一切変えていない(追加的な堅牢化のみ)。10Hz tick・
  遅延権威 sim・相打ち draw・切断猶予の挙動はそのまま。既存テスト(189)は全 green を維持した。

### トレードオフ

- **storage I/O**: checkpoint のたびに `put` が走る。10Hz 全 tick を避け「意味的変化時のみ」へ
  絞ったが、発動が頻発する局面では書き込み頻度が上がる(1 キーへまとめて緩和)。
- **復元の複雑性**: MatchEngine だけでなく MatchSession の権威クロック・入力バッファ・room/席・
  grace deadline まで復元経路に含めるため、保存対象の取りこぼしが直ちに desync を招く。1 キー集約と
  シグネチャ一致テストで担保する。
- **書き込み契機の調整**: 「意味的変化」をシグネチャ差分で近似するため、シグネチャに載らない状態
  (例: 純粋な時間経過のみ)は checkpoint されない。これは alarm() が疎イベントで巻き取る設計で
  補う(時間切れは alarm が finalize する)。閾値・契機は今後のチューニング余地として残る。
