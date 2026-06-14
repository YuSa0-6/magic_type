# 0008. バトルの状態同期を時間軸と入力軸に分割し、rAF を撤廃する

- ステータス: 承認
- 日付: 2026-06-14
- 関連: ADR 0002(純TSエンジン分離・UIは薄い皮)を具体化、ADR 0007(先行入力のドレイン契機を提供)

## 文脈

`Game.svelte` の `requestAnimationFrame` ループがバトル中ずっと回り、毎フレーム
`engine.snapshot(performance.now())` を新オブジェクトで生成して `$state` に全置換して
いた。`snapshot()` は毎回 `{...}` と `hand.slice()` で新参照を返すため、Svelte の
`$state` シグナルが毎フレーム DIRTY 化し、`BattleScreen` の全 `$derived`/`{#each}`/
テンプレ式が 60fps で再評価される。

レビューと敵対的検証で次が確認された:

- DOM への書き込みは Svelte の等価チェック(`update_derived` の `!equals`、`set_text`)で
  ガードされるため、**描画破綻は起きない**。実害は「入力ゼロでも回り続ける JS 再計算 +
  GC churn + 常時 60fps 稼働(電力/発熱)」に留まる。
- 表示解像度は実質 10Hz(経過時間 0.1 秒・HP バー 10 段階)で、60fps は 6〜60 倍過剰。
- つまり「遅い」のではなく、`immutable snapshot を単一 $state に丸ごと持ち毎フレーム
  全置換する」実装が Svelte 5 の fine-grained 反応性と構造的に噛み合っていない。

検討した案:

- **A. UI 側のみ**: rAF を撤廃し `setInterval` で時間表示だけ更新、`snapshot()` は温存
- **B. エンジン API も分割**: `snapshotTimers(atMs)`(時間軸) と `snapshotState()`(入力軸) に分け、UI は別 `$state` で保持
- **C. 現状維持**: 低緊急(電力のみ)として据え置き

## 決定

**B を採用する。**

- `engine.snapshot(atMs)` を 2 つに分割する:
  - `snapshotTimers(atMs)` → `{ elapsedMs, cooldownRemainingMs, finished }` の時間依存のみ(軽量)
  - `snapshotState()` → `{ targetHp, targetMaxHp, hand, selectedIndex, typedRomaji,
    remainingGuide, castMistypes, drawPileCount, discardPileCount }` の入力依存(`atMs` 不要)
- UI はこれらを別々の `$state` に持つ。時間軸は `setInterval`(約 100ms)で更新し、
  入力軸は keydown 後にのみ更新する。**rAF は撤廃する。**
- 終了判定は `activate` 内で確定するためポーリングは不要。ただし時間 tick が
  ADR 0007 の先行入力バッファのドレイン契機を兼ね、ドレインで入力軸が変化した場合は
  入力軸スナップショットも更新する。
- ADR 0002 の「immutable スナップショットだけを状態に持つ」は維持する(返り値は依然 immutable)。

## 結果

### 良い点

- 常時 60fps のアイドルループが消え、電力・発熱の無駄がなくなる。
- 入力レイテンシ経路が時間ポーリングから独立し、将来 PvP(クライアント予測/サーバー和解)で
  入力経路を時間更新と切り離せる(ADR 0009)。
- 入力が変わらない限り入力軸の再評価が走らなくなる。

### トレードオフ

- 公開境界が 1 メソッド(`snapshot`)から 2 メソッドに増え、呼び出し側が 2 系統になる。
- 時間軸の更新頻度が interval に律速される(表示解像度に合わせるので実害はない)。
- 検証では「現規模の体感実利は乏しい(正しいが効きは小さい)」と評価された。本決定の
  主目的は省電力と将来の土台であり、現時点の速度改善ではない。
