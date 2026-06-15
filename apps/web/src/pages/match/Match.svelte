<script lang="ts">
  import {
    MatchEngine,
    type MatchSnapshot,
    type MatchTimers,
    type MatchOutcome,
  } from '@magic/server/engine';
  import { loadDeckOrDefault } from '../../lib/deck-storage';
  import { MatchBot } from '../../lib/match-bot';
  import MatchStartScreen from './MatchStartScreen.svelte';
  import MatchBattleScreen from './MatchBattleScreen.svelte';
  import MatchResultScreen from './MatchResultScreen.svelte';

  // オフライン対戦(対ボット)の親(ADR 0010/0011)。Game.svelte と同じ構成で、
  // BattleEngine を MatchEngine に、的の HP を「相手陣の HP」に置き換えたもの。
  // v1 はサーバー無しなので相手陣をローカルの簡易ボットで駆動する(後続 B で WS 配線)。
  type Phase = 'start' | 'battle' | 'result';

  // 自陣 / ボットの陣営 ID。snapshot(SELF_ID) で self/opponent が決まる(ADR 0011 #3)。
  const SELF_ID = 'self';
  const BOT_ID = 'bot';

  // エンジン本体・ボットは $state にしない(ADR 0002: スナップショットだけを状態に持つ)。
  // retry() で作り直すが、再描画は snapshot/timers の更新で起こすため非リアクティブで意図的。
  // svelte-ignore non_reactive_update
  let engine = createEngine();
  // svelte-ignore non_reactive_update
  let bot = new MatchBot(engine, BOT_ID);

  let phase = $state<Phase>('start');
  // 表示の正を入力軸(snapshot)と時間軸(timers)に分ける(ADR 0008)。
  // 毎回まるごと置換するため $state.raw で十分。
  let snapshot: MatchSnapshot = $state.raw(engine.snapshot(SELF_ID));
  let timers: MatchTimers = $state.raw(engine.snapshotTimers(SELF_ID, performance.now()));
  // 決着の確定 outcome(リザルト表示用)。retry でリセットする。
  let finalOutcome: MatchOutcome | null = $state.raw(null);

  // IME(日本語入力)がオンのまま打鍵された疑いを示す警告フラグ(Game.svelte と同じ扱い)。
  let imeWarning = $state(false);

  // 自陣のデッキ(保存済みが正当ならそれ、無ければ STARTER_DECK)+ ボットは固定の既定デッキ。
  function createEngine(): MatchEngine {
    const selfDeck = loadDeckOrDefault();
    const botDeck = loadDeckOrDefault();
    return new MatchEngine([
      { id: SELF_ID, deck: selfDeck },
      { id: BOT_ID, deck: botDeck },
    ]);
  }

  // 入力軸スナップショットを取り直し、決着していればリザルトへ遷移する。
  // timers も操作直後に取り直してよい(クールダウン開始などを即反映するため)。
  function refresh(now: number): void {
    snapshot = engine.snapshot(SELF_ID);
    timers = engine.snapshotTimers(SELF_ID, now);
    if (snapshot.outcome.kind !== 'ongoing' && phase === 'battle') {
      finalOutcome = snapshot.outcome;
      phase = 'result';
    }
  }

  // 時間 tick(約 100ms, ADR 0008)。rAF は使わない。
  // 役割: ①自陣の先行入力ドレイン(ADR 0007)②ボットの手を進める ③時間切れ判定 ④表示更新。
  $effect(() => {
    if (phase !== 'battle') {
      return;
    }
    const id = setInterval(() => {
      const now = performance.now();
      // 自陣のクールダウン明け先行入力をドレイン(自陣の時間 tick 契機, ADR 0007/0008)。
      const selfChanged = engine.drainTypeahead(SELF_ID, now);
      // ボットの手を進める(相手陣の駆動。内部で相手側の drainTypeahead も行う)。
      const botChanged = bot.step(now);
      // 時間切れの権威判定(本来はサーバーの alarm, ADR 0011 #10。v1 はローカルで代行)。
      const timedUp = engine.evaluateTimeUp(now);
      if (selfChanged || botChanged || timedUp) {
        refresh(now);
      } else {
        timers = engine.snapshotTimers(SELF_ID, now);
      }
    }, 100);
    return () => clearInterval(id);
  });

  // 対戦開始。
  function startMatch(): void {
    const now = performance.now();
    engine.start(now);
    phase = 'battle';
    refresh(now);
  }

  // リザルトから再戦する。エンジン・ボットを作り直してすぐ開始する。
  function retry(): void {
    engine = createEngine();
    bot = new MatchBot(engine, BOT_ID);
    finalOutcome = null;
    imeWarning = false;
    const now = performance.now();
    engine.start(now);
    phase = 'battle';
    refresh(now);
  }

  // カードクリック(マウス操作)。自陣のみ操作可能。
  function handleSelectCard(handIndex: number): void {
    const now = performance.now();
    engine.selectCard(SELF_ID, handIndex, now);
    refresh(now);
  }

  // window の keydown を一元処理する(対戦画面の表示中のみ捕捉される)。Game.svelte と同じ規約。
  function handleKeydown(e: KeyboardEvent): void {
    // IME 変換中の keydown は弾き、警告フラグで気づかせる(Game.svelte と同じ)。
    if (e.isComposing || e.keyCode === 229) {
      imeWarning = true;
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    if (e.repeat) {
      return;
    }

    if (phase === 'start') {
      if (e.key === ' ') {
        e.preventDefault();
        startMatch();
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

    // 対戦中の入力処理(自陣のみ)。
    const now = performance.now();
    if (e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      engine.selectCard(SELF_ID, Number(e.key) - 1, now);
      refresh(now);
      return;
    }
    if (e.key === '-' || (e.key.length === 1 && e.key >= 'a' && e.key <= 'z')) {
      e.preventDefault();
      const result = engine.pressKey(SELF_ID, e.key, now);
      if (result === 'accepted' || result === 'activated' || result === 'buffered') {
        imeWarning = false;
      }
      refresh(now);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if phase === 'start'}
  <MatchStartScreen />
{:else if phase === 'battle'}
  <MatchBattleScreen {snapshot} {timers} {imeWarning} onSelectCard={handleSelectCard} />
{:else if finalOutcome}
  <MatchResultScreen outcome={finalOutcome} {snapshot} />
{/if}
