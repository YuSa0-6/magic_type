<script lang="ts">
  import type { BattleTimers, BattleState } from '@magic/server/engine';

  // バトル画面: スナップショットを表示するだけの薄い皮(ADR 0002)。
  // 業務ロジックは持たず、カードクリックは親へ通知するのみ。
  // 状態は時間軸(timers)と入力軸(state)に分かれる(ADR 0008)。
  interface Props {
    state: BattleState;
    timers: BattleTimers;
    imeWarning: boolean;
    onSelectCard: (handIndex: number) => void;
    /** 効果音のミュート状態(表示専用)。状態は親が sound モジュール経由で保持する。 */
    muted: boolean;
    /** ミュート切替を親へ通知する(状態の書き込みは親で行う, ADR 0002)。 */
    onToggleMute: () => void;
  }

  const { state, timers, imeWarning, onSelectCard, muted, onToggleMute }: Props = $props();

  // ミュートトグルのクリック。トグル後はボタンを blur して以後の打鍵を妨げない(ADR 0012)。
  function handleMuteClick(e: MouseEvent): void {
    onToggleMute();
    (e.currentTarget as HTMLButtonElement).blur();
  }

  // HPのテキストバー(████████░░ 形式)を作る。表示専用の整形であり判定ではない。
  const BAR_LENGTH = 10;
  const hpBar = $derived.by(() => {
    const ratio = state.targetMaxHp === 0 ? 0 : state.targetHp / state.targetMaxHp;
    const filled = Math.round(ratio * BAR_LENGTH);
    return '█'.repeat(filled) + '░'.repeat(BAR_LENGTH - filled);
  });

  // ミリ秒を0.1秒単位の文字列に整形する。
  function formatSeconds(ms: number): string {
    return (ms / 1000).toFixed(1);
  }

  const isOnCooldown = $derived(timers.cooldownRemainingMs > 0);
  const selectedCard = $derived(
    state.selectedIndex === null ? null : state.hand[state.selectedIndex]
  );
</script>

<section class="battle">
  <!-- 的のHPと経過時間 -->
  <div class="status">
    <div class="hp">
      的のHP: <span class="bar">{hpBar}</span>
      {state.targetHp}/{state.targetMaxHp}
    </div>
    <div class="status-right">
      <div class="time">経過時間: {formatSeconds(timers.elapsedMs)}秒</div>
      <button
        type="button"
        class="mute"
        aria-label={muted ? '効果音をオンにする' : '効果音をオフにする'}
        aria-pressed={muted}
        onclick={handleMuteClick}
      >
        {muted ? '🔇' : '🔊'}
      </button>
    </div>
  </div>

  <!-- 手札4枚 -->
  <div class="hand">
    {#each state.hand as card, i (i)}
      <button
        type="button"
        class="card"
        class:selected={state.selectedIndex === i}
        onclick={() => onSelectCard(i)}
      >
        <div class="card-no">{i + 1}</div>
        <div class="card-name">{card.name}</div>
        <div class="card-damage">ダメージ {card.damage}</div>
        {#if isOnCooldown}
          <div class="card-cooldown">クールダウン中</div>
        {/if}
      </button>
    {/each}
  </div>

  <!-- 選択中カードのお題と詠唱状況 -->
  <div class="cast">
    {#if selectedCard}
      <div class="display-text">{selectedCard.displayText}</div>
      <div class="reading">読み: {selectedCard.reading}</div>
      <div class="guide">
        <span class="typed">{state.typedRomaji}</span><span class="remaining"
          >{state.remainingGuide}</span
        >
      </div>
    {:else}
      <div class="no-select">カードを選択してください(1〜4キー / クリック)</div>
    {/if}
  </div>

  <!-- IME(日本語入力)オンの疑いがあるときの注意表示 -->
  {#if imeWarning}
    <div class="ime-warning" role="alert">
      日本語入力(IME)がオンのようです。半角英数で入力してください
    </div>
  {/if}

  <!-- 詳細情報 -->
  <div class="info">
    <span>誤入力: {state.castMistypes}</span>
    <span>山札: {state.drawPileCount}枚</span>
    <span>捨て札: {state.discardPileCount}枚</span>
    <span>クールダウン残り: {formatSeconds(timers.cooldownRemainingMs)}秒</span>
  </div>
</section>

<style>
  .battle {
    width: 100%;
    max-width: 720px;
    font-family: 'Courier New', monospace;
  }

  .status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 1.1rem;
    margin-bottom: 1rem;
  }

  .status-right {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .mute {
    border: 1px solid #bbb;
    border-radius: 6px;
    background: #fafafa;
    padding: 0.2rem 0.4rem;
    cursor: pointer;
    font-family: inherit;
    font-size: 1rem;
    line-height: 1;
  }

  .mute:hover {
    background: #eee;
  }

  .bar {
    letter-spacing: 1px;
    color: #c62828;
  }

  .hand {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .card {
    flex: 1;
    border: 2px solid #bbb;
    border-radius: 6px;
    background: #fafafa;
    padding: 0.6rem 0.4rem;
    cursor: pointer;
    text-align: center;
    font-family: inherit;
  }

  .card.selected {
    border-color: #1565c0;
    background: #e3f2fd;
    box-shadow: 0 0 0 2px #1565c0 inset;
  }

  .card-no {
    font-weight: bold;
    color: #1565c0;
  }

  .card-name {
    font-size: 1.1rem;
    margin: 0.2rem 0;
  }

  .card-damage {
    font-size: 0.85rem;
    color: #555;
  }

  .card-cooldown {
    font-size: 0.8rem;
    color: #c62828;
    margin-top: 0.2rem;
  }

  .cast {
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 1rem;
    margin-bottom: 1rem;
    min-height: 4.5rem;
  }

  .display-text {
    font-size: 1.3rem;
    font-family: sans-serif;
    margin-bottom: 0.3rem;
  }

  .reading {
    color: #777;
    font-size: 0.9rem;
    margin-bottom: 0.6rem;
  }

  .guide {
    font-size: 1.4rem;
    letter-spacing: 1px;
  }

  .typed {
    color: #2e7d32;
  }

  .remaining {
    color: #999;
  }

  .no-select {
    color: #999;
  }

  .ime-warning {
    border: 1px solid #f0c36d;
    background: #fff8e1;
    color: #8a6d00;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.95rem;
  }

  .info {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    font-size: 0.9rem;
    color: #555;
  }
</style>
