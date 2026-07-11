<script lang="ts">
  import {
    MatchEngine,
    type MatchSnapshot,
    type MatchTimers,
    type MatchOutcome,
  } from '@magic/server/engine';
  import { loadDeckOrDefault } from '../../lib/deck-storage';
  import { MatchBot } from '../../lib/match-bot';
  import * as sound from '../../lib/sound.svelte';
  import MatchStartScreen from './MatchStartScreen.svelte';
  import MatchBattleScreen from './MatchBattleScreen.svelte';
  import MatchResultScreen from './MatchResultScreen.svelte';

  // オフライン対戦(対ボット)の親(ADR 0010/0011)。Game.svelte と同じ構成で、
  // BattleEngine を MatchEngine に、的の HP を「相手陣の HP」に置き換えたもの。
  // v1 はサーバー無しなので相手陣をローカルの簡易ボットで駆動する(後続 B で WS 配線)。
  // 'start'(準備) → 'countdown'(開始演出) → 'battle' → 'result' と進む。
  type Phase = 'start' | 'countdown' | 'battle' | 'result';

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
  // 開始カウントダウンの表示値(3→2→1→'go')。null は非カウントダウン(UI 状態のみ, ADR 0008:
  // 秒送りは pages 層で管理しエンジンには触れない)。
  let countdownValue = $state<number | 'go' | null>(null);
  // 表示の正を入力軸(snapshot)と時間軸(timers)に分ける(ADR 0008)。
  // 毎回まるごと置換するため $state.raw で十分。
  let snapshot: MatchSnapshot = $state.raw(engine.snapshot(SELF_ID));
  let timers: MatchTimers = $state.raw(engine.snapshotTimers(SELF_ID, performance.now()));
  // 決着の確定 outcome(リザルト表示用)。retry でリセットする。
  let finalOutcome: MatchOutcome | null = $state.raw(null);

  // IME(日本語入力)がオンのまま打鍵された疑いを示す警告フラグ(Game.svelte と同じ扱い)。
  let imeWarning = $state(false);

  // 効果音のミュート状態(ADR 0002: 状態は親が sound モジュール経由で保持し props で渡す)。
  let muted = $state(sound.isMuted());

  // 盤面結果音(被弾/防御=自陣 / 命中=相手)検出用の前値トラッカー(ADR 0012 の盤面結果節)。
  // 非リアクティブな plain let。null は未観測の番兵で、最初の観測ではベースライン設定のみ行い
  // 鳴らさない(初期満タンや取りこぼしでの誤発火を防ぐ)。新マッチ/再戦で null に戻す。
  let prevSelfHp: number | null = null;
  let prevSelfShield: number | null = null;
  let prevOppHp: number | null = null;

  // ミュートトグル。状態は sound モジュールが正(localStorage 永続)。
  function handleToggleMute(): void {
    sound.toggleMute();
    muted = sound.isMuted();
  }

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
    // 盤面結果音: 自陣 HP/シールド差分で被弾/防御、相手 HP 差分で命中を鳴らす(ADR 0012)。
    // 前値が全て !==null(=ベースライン済み)の時のみ鳴らし、その後に前値を現値へ更新する。
    // tick(ボット攻撃で自陣 HP 減)・自分の打鍵(発動で相手 HP 減)・選択 のどの契機でも
    // 差分で正しく鳴る。相手起点の音(bot.step)を別途鳴らす必要は無い。
    if (prevSelfHp !== null && prevSelfShield !== null && prevOppHp !== null) {
      sound.playSelfDamage(prevSelfHp, snapshot.self.hp, prevSelfShield, snapshot.self.shield);
      sound.playEnemyHit(prevOppHp, snapshot.opponent.hp);
    }
    prevSelfHp = snapshot.self.hp;
    prevSelfShield = snapshot.self.shield;
    prevOppHp = snapshot.opponent.hp;
    timers = engine.snapshotTimers(SELF_ID, now);
    if (snapshot.outcome.kind !== 'ongoing' && phase === 'battle') {
      finalOutcome = snapshot.outcome;
      phase = 'result';
    }
  }

  // 時間 tick(約 100ms, ADR 0008)。rAF は使わない。
  // 役割: ①ボットの手を進める ②時間切れ判定 ③表示更新。
  $effect(() => {
    if (phase !== 'battle') {
      return;
    }
    const id = setInterval(() => {
      const now = performance.now();
      // ボットの手を進める(相手陣の駆動)。
      // 相手の操作・発動は無音(ADR 0012: 音は自分の操作起点のみ)。bot.step は音を鳴らさない。
      const botChanged = bot.step(now);
      // 時間切れの権威判定(本来はサーバーの alarm, ADR 0011 #10。v1 はローカルで代行)。
      const timedUp = engine.evaluateTimeUp(now);
      if (botChanged || timedUp) {
        refresh(now);
      } else {
        timers = engine.snapshotTimers(SELF_ID, now);
      }
    }, 100);
    return () => clearInterval(id);
  });

  // 開始カウントダウンを始める(スペース押下時)。ユーザージェスチャで音システムを起動する
  // (ADR 0012)が、engine.start() はまだ呼ばない。エンジンはコンストラクタで初期状態が確定
  // 済みなので、start を遅らせるだけで減彩盤面+演出を出せる(タイマーは動かない)。
  function beginCountdown(): void {
    sound.resume();
    countdownValue = 3;
    phase = 'countdown';
  }

  // カウントダウン完了。ここで初めてタイマー(とボット駆動)を開始する(旧 startMatch 相当)。
  // interval からの多重呼び出しに備えて phase をガードする。
  function finishCountdown(): void {
    if (phase !== 'countdown') {
      return;
    }
    // 盤面結果音の前値をベースラインし直す(refresh 前に null で初回観測扱い, ADR 0012)。
    prevSelfHp = null;
    prevSelfShield = null;
    prevOppHp = null;
    const now = performance.now();
    engine.start(now);
    phase = 'battle';
    refresh(now);
  }

  // カウントダウンの秒送り(ADR 0008: rAF 不使用の setInterval)。phase==='countdown' の間だけ動く。
  // 3(開始時に設定済み) →1秒→2 →1秒→1 →1秒→'go' →0.6秒→ 開始。各代入は同値なら no-op。
  $effect(() => {
    if (phase !== 'countdown') {
      return;
    }
    const startedAt = performance.now();
    const id = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      if (elapsed >= 3600) {
        finishCountdown();
      } else if (elapsed >= 3000) {
        countdownValue = 'go';
      } else if (elapsed >= 2000) {
        countdownValue = 1;
      } else if (elapsed >= 1000) {
        countdownValue = 2;
      }
    }, 100);
    return () => clearInterval(id);
  });

  // リザルトから再戦する。エンジン・ボットを作り直し、初期スナップショットで減彩盤面を
  // 表示してから、開始時と同じカウントダウンへ入る(演出の一貫性のため)。
  function retry(): void {
    engine = createEngine();
    bot = new MatchBot(engine, BOT_ID);
    finalOutcome = null;
    imeWarning = false;
    snapshot = engine.snapshot(SELF_ID);
    timers = engine.snapshotTimers(SELF_ID, performance.now());
    beginCountdown();
  }

  // カードクリック(マウス操作)。自陣のみ操作可能。
  function handleSelectCard(handIndex: number): void {
    // カウントダウン中はマウスでの選択も無視する(オーバーレイでも遮るが二重の保険)。
    if (phase === 'countdown') {
      return;
    }
    const now = performance.now();
    // 選択が実際に変わった時だけ選択音を鳴らす(同カード再選択・決着後は no-op, ADR 0012)。
    const before = snapshot.self.selectedIndex;
    engine.selectCard(SELF_ID, handIndex, now);
    refresh(now);
    if (snapshot.self.selectedIndex !== before) {
      sound.playSelect();
    }
  }

  // window の keydown を一元処理する(対戦画面の表示中のみ捕捉される)。Game.svelte と同じ規約。
  function handleKeydown(e: KeyboardEvent): void {
    // カウントダウン中は一切の入力を無視する(誤ってエンジンへキーが渡らないよう IME 判定より前)。
    if (phase === 'countdown') {
      return;
    }
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
        beginCountdown();
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
      // 選択が実際に変わった時だけ選択音を鳴らす(ADR 0012)。
      const before = snapshot.self.selectedIndex;
      engine.selectCard(SELF_ID, Number(e.key) - 1, now);
      refresh(now);
      if (snapshot.self.selectedIndex !== before) {
        sound.playSelect();
      }
      return;
    }
    if (e.key === '-' || (e.key.length === 1 && e.key >= 'a' && e.key <= 'z')) {
      e.preventDefault();
      const result = engine.pressKey(SELF_ID, e.key, now);
      sound.playForResult(result);
      if (result === 'accepted' || result === 'activated') {
        imeWarning = false;
      }
      refresh(now);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if phase === 'start'}
  <MatchStartScreen />
{:else if phase === 'countdown' || phase === 'battle'}
  <MatchBattleScreen
    {snapshot}
    {timers}
    nowMs={performance.now()}
    {imeWarning}
    onSelectCard={handleSelectCard}
    {muted}
    onToggleMute={handleToggleMute}
    countdownValue={phase === 'countdown' ? countdownValue : null}
  />
{:else if finalOutcome}
  <MatchResultScreen outcome={finalOutcome} {snapshot} />
{/if}
