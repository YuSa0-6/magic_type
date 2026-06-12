<script lang="ts">
  import { BattleEngine, type BattleSnapshot, STARTER_DECK } from '@magic/engine';
  import StartScreen from './StartScreen.svelte';
  import BattleScreen from './BattleScreen.svelte';
  import ResultScreen from './ResultScreen.svelte';

  // ゲーム内の画面遷移。'start'(準備) → 'battle' → 'result' と進む。
  type Phase = 'start' | 'battle' | 'result';

  // エンジン本体は $state にしない(ADR 0002: スナップショットだけを状態として持つ)。
  // retry() で作り直すが、再描画は refresh() のスナップショット更新で起こすため非リアクティブで意図的。
  // このコンポーネントのアンマウントでエンジンごと破棄される(ゲーム画面を離れたら状態は捨てる)。
  // svelte-ignore non_reactive_update
  let engine = new BattleEngine(STARTER_DECK);

  let phase = $state<Phase>('start');
  // 表示の正はこのスナップショット。入力イベント後と rAF ティックで取り直す。
  let snapshot = $state<BattleSnapshot>(engine.snapshot(performance.now()));

  // 現在時刻でスナップショットを取り直し、終了していればリザルトへ遷移する。
  function refresh(): void {
    snapshot = engine.snapshot(performance.now());
    if (snapshot.finished && phase === 'battle') {
      phase = 'result';
    }
  }

  // requestAnimationFrame のティック。経過時間・クールダウン残りの表示更新に使う。
  $effect(() => {
    if (phase !== 'battle') {
      return;
    }
    let raf = 0;
    const tick = (): void => {
      refresh();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // 準備画面で新しいバトルを開始する。
  function startBattle(): void {
    engine.start(performance.now());
    phase = 'battle';
    refresh();
  }

  // リザルトから再挑戦する。エンジンを新規に作り直し、すぐバトルを開始する。
  function retry(): void {
    engine = new BattleEngine(STARTER_DECK);
    engine.start(performance.now());
    phase = 'battle';
    refresh();
  }

  // カードクリック(マウス操作)。クールダウン中でも選択(構え)は可能。
  function handleSelectCard(handIndex: number): void {
    engine.selectCard(handIndex, performance.now());
    refresh();
  }

  // window の keydown を一元処理する(ゲーム画面の表示中のみ捕捉される)。
  function handleKeydown(e: KeyboardEvent): void {
    // 修飾キー付きはブラウザ標準動作に委ねる(無視)。
    if (e.ctrlKey || e.metaKey || e.altKey) {
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
      refresh();
      return;
    }
    // 英小文字と '-' のみを打鍵としてエンジンへ渡す。
    if (e.key === '-' || (e.key.length === 1 && e.key >= 'a' && e.key <= 'z')) {
      e.preventDefault();
      engine.pressKey(e.key, now);
      refresh();
    }
  }
</script>

<!-- keydown の捕捉はゲーム画面に限定する(ホームでは英字キー等を奪わない)。 -->
<svelte:window onkeydown={handleKeydown} />

{#if phase === 'start'}
  <StartScreen />
{:else if phase === 'battle'}
  <BattleScreen {snapshot} onSelectCard={handleSelectCard} />
{:else}
  <ResultScreen stats={engine.stats()} clearTimeMs={snapshot.clearTimeMs ?? 0} />
{/if}
