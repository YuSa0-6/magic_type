<script lang="ts">
  import {
    BattleEngine,
    type BattleTimers,
    type BattleState,
    type BattleStats,
    STARTER_DECK,
  } from '@magic/server/engine';
  import StartScreen from './StartScreen.svelte';
  import BattleScreen from './BattleScreen.svelte';
  import ResultScreen from './ResultScreen.svelte';

  // ゲーム内の画面遷移。'start'(準備) → 'battle' → 'result' と進む。
  type Phase = 'start' | 'battle' | 'result';

  // エンジン本体は $state にしない(ADR 0002: スナップショットだけを状態として持つ)。
  // retry() で作り直すが、再描画は state/timers の更新で起こすため非リアクティブで意図的。
  // このコンポーネントのアンマウントでエンジンごと破棄される(ゲーム画面を離れたら状態は捨てる)。
  // svelte-ignore non_reactive_update
  let engine = new BattleEngine(STARTER_DECK);

  let phase = $state<Phase>('start');
  // 表示の正を時間軸(timers)と入力軸(battleState)に分ける(ADR 0008)。
  // timers は時間 tick(setInterval)で、battleState は入力イベント後にのみ取り直す。
  // 毎回まるごと置換するため $state.raw で十分。
  // (変数名を battleState とするのは、`state` だと $state ルーンと衝突して svelte-check が誤検知するため)
  let timers: BattleTimers = $state.raw(engine.snapshotTimers(performance.now()));
  let battleState: BattleState = $state.raw(engine.snapshotState());

  // リザルト表示用の統計。テンプレートから engine.stats() を直接呼ばず(ADR 0002/RX-6)、
  // バトル→result へ遷移する瞬間に一度だけ確定させる。retry 時は null にリセットする。
  let finalStats: BattleStats | null = $state.raw(null);

  // IME(日本語入力)がオンのまま打鍵された疑いを示す警告フラグ。
  // 変換中の keydown を検知したら true、半角英小文字の打鍵が受理されたら false に戻す。
  let imeWarning = $state(false);

  // 入力軸スナップショットを取り直し、終了していればリザルトへ遷移する。
  // timers も操作直後に取り直してよい(クールダウン開始などを即反映するため)。
  function refreshState(now: number): void {
    battleState = engine.snapshotState();
    timers = engine.snapshotTimers(now);
    if (battleState.finished && phase === 'battle') {
      finalStats = engine.stats();
      phase = 'result';
    }
  }

  // 時間 tick。経過時間・クールダウン残りの表示更新に使う(rAF は撤廃)。
  // 表示解像度(0.1秒・HP10段階)に対し 100ms で十分。
  // 併せて先行入力バッファのドレイン契機も兼ねる(ADR 0007/0008)。
  $effect(() => {
    if (phase !== 'battle') {
      return;
    }
    const id = setInterval(() => {
      const now = performance.now();
      // クールダウン明けの先行入力をまとめて受理する。入力軸が変われば取り直す。
      const changed = engine.drainTypeahead(now);
      if (changed) {
        battleState = engine.snapshotState();
        if (battleState.finished && phase === 'battle') {
          finalStats = engine.stats();
          phase = 'result';
        }
      }
      timers = engine.snapshotTimers(now);
    }, 100);
    return () => clearInterval(id);
  });

  // 準備画面で新しいバトルを開始する。
  function startBattle(): void {
    const now = performance.now();
    engine.start(now);
    phase = 'battle';
    refreshState(now);
  }

  // リザルトから再挑戦する。エンジンを新規に作り直し、すぐバトルを開始する。
  function retry(): void {
    engine = new BattleEngine(STARTER_DECK);
    finalStats = null;
    imeWarning = false;
    const now = performance.now();
    engine.start(now);
    phase = 'battle';
    refreshState(now);
  }

  // カードクリック(マウス操作)。クールダウン中でも選択(構え)は可能。
  function handleSelectCard(handIndex: number): void {
    const now = performance.now();
    engine.selectCard(handIndex, now);
    refreshState(now);
  }

  // window の keydown を一元処理する(ゲーム画面の表示中のみ捕捉される)。
  function handleKeydown(e: KeyboardEvent): void {
    // IME(日本語入力)変換中の keydown は無視する。変換確定前のキーは
    // isComposing が立つか、keyCode 229(IME 処理中の合成キーコード)になる。
    // 単に弾くだけでは無音の取りこぼしになるため、警告フラグを立てて UX で気づかせる。
    if (e.isComposing || e.keyCode === 229) {
      imeWarning = true;
      return;
    }
    // 修飾キー付きはブラウザ標準動作に委ねる(無視)。
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    // OS/ハードのオートリピート(押しっぱなし)由来の keydown は弾く。
    // 別個の keydown である連打は通るので、暴発だけを防げる。
    if (e.repeat) {
      return;
    }

    if (phase === 'start') {
      if (e.key === ' ') {
        e.preventDefault();
        startBattle();
      }
      return;
    }

    if (phase === 'result') {
      if (e.key === ' ') {
        e.preventDefault();
        retry();
      }
      return;
    }

    // バトル中の入力処理。
    const now = performance.now();
    if (e.key >= '1' && e.key <= '4') {
      // 数字1〜4 → カード選択(0始まりのインデックスへ変換)。
      e.preventDefault();
      engine.selectCard(Number(e.key) - 1, now);
      refreshState(now);
      return;
    }
    // 英小文字と '-' のみを打鍵としてエンジンへ渡す。
    if (e.key === '-' || (e.key.length === 1 && e.key >= 'a' && e.key <= 'z')) {
      e.preventDefault();
      const result = engine.pressKey(e.key, now);
      // 半角英小文字が正常に受理(または発動)されたら IME 警告を解除する。
      if (result === 'accepted' || result === 'activated') {
        imeWarning = false;
      }
      refreshState(now);
    }
  }
</script>

<!-- keydown の捕捉はゲーム画面に限定する(ホームでは英字キー等を奪わない)。 -->
<svelte:window onkeydown={handleKeydown} />

{#if phase === 'start'}
  <StartScreen />
{:else if phase === 'battle'}
  <BattleScreen
    state={battleState}
    {timers}
    {imeWarning}
    onSelectCard={handleSelectCard}
  />
{:else if finalStats}
  <ResultScreen stats={finalStats} clearTimeMs={battleState.clearTimeMs ?? 0} />
{/if}
