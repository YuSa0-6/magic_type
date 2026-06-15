<script lang="ts">
  import type { MatchSnapshot, MatchTimers, PlayerState } from '@magic/server/engine';

  // 対戦バトル画面: 2 陣営のスナップショットを表示するだけの薄い皮(ADR 0002)。
  // 業務ロジックは持たず、カードクリックは親へ通知するのみ。自陣のみ操作可能。
  // 状態は入力軸(snapshot)と時間軸(timers)に分かれる(ADR 0008)。
  interface Props {
    snapshot: MatchSnapshot;
    timers: MatchTimers;
    imeWarning: boolean;
    onSelectCard: (handIndex: number) => void;
    /** 相手の表示名(オフラインは「相手(ボット)」、オンラインは「相手」)。 */
    opponentLabel?: string;
    /** 接続状況などのバナー文言(オンラインの切断/再接続表示用)。未指定なら出さない。 */
    statusBanner?: string | null;
  }

  const {
    snapshot,
    timers,
    imeWarning,
    onSelectCard,
    opponentLabel = '相手(ボット)',
    statusBanner = null,
  }: Props = $props();

  const self = $derived(snapshot.self);
  const opponent = $derived(snapshot.opponent);

  // HP のテキストバー(████████░░ 形式)。表示専用の整形であり判定ではない。
  const BAR_LENGTH = 12;
  function hpBar(p: PlayerState): string {
    const ratio = p.maxHp === 0 ? 0 : p.hp / p.maxHp;
    const filled = Math.round(ratio * BAR_LENGTH);
    return '█'.repeat(filled) + '░'.repeat(BAR_LENGTH - filled);
  }

  function formatSeconds(ms: number): string {
    return (ms / 1000).toFixed(1);
  }

  // 持続効果(haste/slow)を日本語ラベルに整形する(表示専用)。
  function effectLabel(kind: 'haste' | 'slow'): string {
    return kind === 'haste' ? '加速' : '鈍化';
  }

  const selfOnCooldown = $derived(timers.selfCooldownRemainingMs > 0);
  const selectedCard = $derived(self.selectedIndex === null ? null : self.hand[self.selectedIndex]);
</script>

<section class="battle">
  <!-- 接続状況バナー(オンラインの切断/再接続表示用)。 -->
  {#if statusBanner}
    <div class="status-banner" role="status">{statusBanner}</div>
  {/if}

  <!-- 制限時間 -->
  <div class="timebar">
    残り時間 <strong>{formatSeconds(timers.remainingMs)}</strong> 秒
  </div>

  <!-- 相手陣(伏せ / 進捗のみ) -->
  <div class="side opponent">
    <div class="side-head">
      <span class="who">{opponentLabel}</span>
      <span class="hp-num">{opponent.hp}/{opponent.maxHp}</span>
    </div>
    <div class="hp-row">
      <span class="bar opp-bar">{hpBar(opponent)}</span>
      {#if opponent.shield > 0}
        <span class="shield">シールド {opponent.shield}</span>
      {/if}
    </div>
    {#if opponent.activeEffects.length > 0}
      <div class="effects">
        {#each opponent.activeEffects as eff (eff.kind)}
          <span class="effect" class:haste={eff.kind === 'haste'} class:slow={eff.kind === 'slow'}>
            {effectLabel(eff.kind)}
          </span>
        {/each}
      </div>
    {/if}
    <!-- 相手の手札は伏せ。進捗(詠唱中か / ガイド長)だけ示す。 -->
    <div class="opp-hand">
      {#each opponent.hand as _card, i (i)}
        <div class="opp-card" class:casting={opponent.selectedIndex === i}>?</div>
      {/each}
    </div>
    <div class="opp-cast">
      {#if opponent.selectedIndex !== null}
        詠唱中… 進捗 {opponent.typedRomaji.length} 文字
        <span class="cd">(クールダウン {formatSeconds(timers.opponentCooldownRemainingMs)}秒)</span>
      {:else}
        構え中…
      {/if}
    </div>
  </div>

  <div class="vs">VS</div>

  <!-- 自陣 -->
  <div class="side self">
    <div class="side-head">
      <span class="who">自分</span>
      <span class="hp-num">{self.hp}/{self.maxHp}</span>
    </div>
    <div class="hp-row">
      <span class="bar self-bar">{hpBar(self)}</span>
      {#if self.shield > 0}
        <span class="shield">シールド {self.shield}</span>
      {/if}
    </div>
    {#if self.activeEffects.length > 0}
      <div class="effects">
        {#each self.activeEffects as eff (eff.kind)}
          <span class="effect" class:haste={eff.kind === 'haste'} class:slow={eff.kind === 'slow'}>
            {effectLabel(eff.kind)}
          </span>
        {/each}
      </div>
    {/if}

    <!-- 自陣の手札4枚(操作可) -->
    <div class="hand">
      {#each self.hand as card, i (i)}
        <button
          type="button"
          class="card"
          class:selected={self.selectedIndex === i}
          onclick={() => onSelectCard(i)}
        >
          <div class="card-no">{i + 1}</div>
          <div class="card-name">{card.name}</div>
          <div class="card-damage">ダメージ {card.damage}</div>
          {#if card.effects.length > 0}
            <div class="card-effect">効果あり</div>
          {/if}
          {#if selfOnCooldown}
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
          <span class="typed">{self.typedRomaji}</span><span class="remaining"
            >{self.remainingGuide}</span
          >
        </div>
      {:else}
        <div class="no-select">カードを選択してください(1〜4キー / クリック)</div>
      {/if}
    </div>

    {#if imeWarning}
      <div class="ime-warning" role="alert">
        日本語入力(IME)がオンのようです。半角英数で入力してください
      </div>
    {/if}

    <!-- 自陣の詳細情報 -->
    <div class="info">
      <span>誤入力: {self.castMistypes}</span>
      <span>山札: {self.drawPileCount}枚</span>
      <span>捨て札: {self.discardPileCount}枚</span>
      <span>クールダウン残り: {formatSeconds(timers.selfCooldownRemainingMs)}秒</span>
    </div>
  </div>
</section>

<style>
  .battle {
    width: 100%;
    max-width: 720px;
    font-family: 'Courier New', monospace;
  }

  .status-banner {
    text-align: center;
    background: #fff8e1;
    border: 1px solid #f0c36d;
    color: #8a6d00;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.8rem;
    font-size: 0.95rem;
  }

  .timebar {
    text-align: center;
    font-size: 1.1rem;
    margin-bottom: 0.8rem;
    color: #555;
  }

  .timebar strong {
    color: #1565c0;
    font-size: 1.3rem;
  }

  .side {
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 0.8rem;
    margin-bottom: 0.5rem;
  }

  .side.opponent {
    background: #fff5f5;
    border-color: #f1c0c0;
  }

  .side.self {
    background: #f3f8ff;
    border-color: #bcd6f5;
  }

  .side-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 1.05rem;
    margin-bottom: 0.3rem;
  }

  .who {
    font-weight: bold;
  }

  .hp-num {
    font-weight: bold;
  }

  .hp-row {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 0.3rem;
  }

  .bar {
    letter-spacing: 1px;
    font-size: 1.1rem;
  }

  .opp-bar {
    color: #c62828;
  }

  .self-bar {
    color: #2e7d32;
  }

  .shield {
    font-size: 0.8rem;
    color: #1565c0;
    background: #e3f2fd;
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
  }

  .effects {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.3rem;
  }

  .effect {
    font-size: 0.75rem;
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
  }

  .effect.haste {
    color: #1b5e20;
    background: #e8f5e9;
  }

  .effect.slow {
    color: #8a6d00;
    background: #fff8e1;
  }

  .opp-hand {
    display: flex;
    gap: 0.4rem;
    margin: 0.4rem 0;
  }

  .opp-card {
    flex: 1;
    border: 2px solid #e0aaaa;
    border-radius: 6px;
    background: #fbe9e9;
    padding: 0.8rem 0;
    text-align: center;
    font-size: 1.2rem;
    color: #b06a6a;
  }

  .opp-card.casting {
    border-color: #c62828;
    box-shadow: 0 0 0 2px #c62828 inset;
    color: #c62828;
  }

  .opp-cast {
    font-size: 0.85rem;
    color: #777;
  }

  .opp-cast .cd {
    color: #999;
  }

  .vs {
    text-align: center;
    font-weight: bold;
    color: #999;
    margin: 0.3rem 0;
  }

  .hand {
    display: flex;
    gap: 0.5rem;
    margin: 0.5rem 0 1rem;
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
    font-size: 1.05rem;
    margin: 0.2rem 0;
  }

  .card-damage {
    font-size: 0.8rem;
    color: #555;
  }

  .card-effect {
    font-size: 0.75rem;
    color: #6a1b9a;
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
    margin-bottom: 0.8rem;
    min-height: 4.5rem;
    background: #fff;
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
    margin-bottom: 0.8rem;
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
