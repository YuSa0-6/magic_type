<script lang="ts">
  import type { BattleTimers, BattleState, Card as CardModel } from '@magic/server/engine';
  import Card from '../../ui/Card.svelte';
  import HpBar from '../../ui/HpBar.svelte';
  import Panel from '../../ui/Panel.svelte';
  import StatusBadge from '../../ui/StatusBadge.svelte';
  import { formatSeconds } from '../../lib/format';
  import { HAND_ROTATIONS } from '../../lib/card-format';

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

  const selectedCard = $derived(
    state.selectedIndex === null ? null : state.hand[state.selectedIndex]
  );

  // CD ゲージは「回復の進捗」を 0→1 で表す。timers は残り時間なので 1 から引いて反転する。
  // 進捗率の割り算は pages 側で行い、Card には算出済みの値だけ渡す(ADR 0006)。
  // 注意: 分母に手札カード自身の cooldownMs を使っているのは、タイムアタック
  // エンジン(battle.ts)が全カード共通の cooldownMs=1500 かつ haste/slow を
  // 持たないため。対戦(vs ボット/オンライン)は cooldownMs が異なるカードや
  // 加速/鈍化効果を持ちうるので、この式をそのまま MatchBattleScreen へ流用しない。
  function cooldownRecovery(card: CardModel): number | undefined {
    if (timers.cooldownRemainingMs <= 0) return undefined;
    return 1 - timers.cooldownRemainingMs / card.cooldownMs;
  }
</script>

<div class="stage-viewport">
  <div class="stage">
    <section class="battle">
      <!-- 上段: 的のHP(左)と経過時間・ミュート(右) -->
      <header class="top">
        <div class="target">
          {#if imeWarning}
            <StatusBadge
              variant="warning"
              label="日本語入力(IME)がオンのようです。半角英数で入力してください"
            />
          {/if}
          <div class="target-label">的</div>
          <HpBar hp={state.targetHp} maxHp={state.targetMaxHp} side="opponent" />
          <div class="target-num">{state.targetHp} / {state.targetMaxHp}</div>
        </div>

        <div class="clock">
          <span class="clock-label">経過</span>
          <span class="clock-num">{formatSeconds(timers.elapsedMs)}</span>
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
      </header>

      <!-- 中段: 詠唱枠 -->
      <div class="cast">
        <Panel variant="parchment">
          <div class="cast-body">
            {#if selectedCard}
              <div class="cast-title">{selectedCard.displayText}</div>
              <div class="cast-kana">{selectedCard.reading}</div>
              <div class="cast-romaji">
                <span class="typed">{state.typedRomaji}</span><span class="remaining"
                  >{state.remainingGuide}</span
                >
              </div>
            {:else}
              <div class="cast-empty">カードを選択してください(左から 1〜4 キー / クリック)</div>
            {/if}
          </div>
        </Panel>
      </div>

      <!-- 下段: 詳細情報(左)・手札4枚(中央)・山札/捨て札(右) -->
      <footer class="bottom">
        <div class="side-info left">
          <div>
            <span class="info-label">誤入力</span>
            <span class="info-num">{state.castMistypes}</span>
          </div>
          <div>
            <span class="info-label">CD残り</span>
            <span class="info-num">{formatSeconds(timers.cooldownRemainingMs)}秒</span>
          </div>
        </div>

        <div class="hand">
          {#each state.hand as card, i (i)}
            <Card
              face="front"
              {card}
              width={150}
              interactive
              rotateDeg={HAND_ROTATIONS[i] ?? 0}
              selected={state.selectedIndex === i}
              cooldownProgress={cooldownRecovery(card)}
              onSelect={() => onSelectCard(i)}
            />
          {/each}
        </div>

        <div class="side-info right">
          <div>
            <span class="info-label">山札</span> <span class="info-num">{state.drawPileCount}</span>
          </div>
          <div>
            <span class="info-label">捨て札</span>
            <span class="info-num">{state.discardPileCount}</span>
          </div>
        </div>
      </footer>
    </section>
  </div>
</div>

<style>
  .battle {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 70px 90px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-radial-battle);
    font-family: var(--font-body);
  }

  /* 上段 */
  .top {
    width: 100%;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 40px;
  }

  .target {
    width: 460px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .target-label {
    font-family: var(--font-serif);
    font-size: 30px;
    font-weight: 700;
    color: var(--text-heading);
  }

  .target-num {
    font-family: var(--font-mono);
    font-size: 22px;
    color: var(--text-body);
  }

  .clock {
    display: flex;
    align-items: baseline;
    gap: 14px;
  }

  .clock-label {
    font-size: 22px;
    color: var(--text-faint);
  }

  .clock-num {
    font-family: var(--font-mono);
    font-size: 44px;
    font-weight: 700;
    color: var(--gold-bright);
    letter-spacing: 0.02em;
  }

  .mute {
    align-self: center;
    margin-left: 6px;
    width: 52px;
    height: 52px;
    border: 2px solid var(--gold);
    border-radius: 12px;
    background: rgba(201, 163, 90, 0.06);
    color: var(--text-heading);
    cursor: pointer;
    font-size: 24px;
    line-height: 1;
    transition: box-shadow 0.12s ease-out;
  }

  .mute:hover,
  .mute:focus-visible {
    box-shadow: 0 0 18px var(--gold-glow-25);
    outline: none;
  }

  /* 中段 */
  .cast {
    width: 980px;
  }

  .cast-body {
    padding: 30px 40px;
    text-align: center;
    min-height: 150px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .cast-title {
    font-family: var(--font-serif);
    font-size: 40px;
    font-weight: 700;
    color: var(--parchment-text);
  }

  .cast-kana {
    font-size: 24px;
    color: var(--parchment-text-sub);
  }

  .cast-romaji {
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 44px;
    letter-spacing: 0.04em;
  }

  .cast-romaji .typed {
    color: var(--romaji-typed);
    font-weight: 700;
  }

  .cast-romaji .remaining {
    color: var(--romaji-remaining);
  }

  .cast-empty {
    font-size: 32px;
    color: var(--parchment-text-sub);
  }

  /* 下段 */
  .bottom {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: end;
  }

  .hand {
    display: flex;
    justify-content: center;
    align-items: flex-end;
    gap: 44px;
  }

  .side-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--text-body);
    font-size: 22px;
  }

  .side-info.left {
    align-items: flex-start;
  }

  .side-info.right {
    align-items: flex-end;
  }

  .info-label {
    color: var(--text-faint);
  }

  .info-num {
    font-family: var(--font-mono);
    color: var(--text-heading);
  }
</style>
