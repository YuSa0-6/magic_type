<script lang="ts">
  import type { MatchOutcome, MatchSnapshot, EndReason } from '@magic/server/engine';
  import { handleNavClick } from '../../lib/router.svelte';
  import Button from '../../ui/Button.svelte';
  import HpBar from '../../ui/HpBar.svelte';

  // 対戦リザルト画面: 確定した outcome と最終 HP を表示するだけ(整形のみ, ADR 0002)。
  // 再戦操作(スペースキー)は Match 側の window keydown で処理する。

  /** 再戦(#17, オンライン対戦のみ)。オフライン(vsボット)は渡さないので従来の見た目のまま。 */
  interface RematchState {
    readonly countdownSeconds: number;
    readonly selfRequested: boolean;
    readonly opponentRequested: boolean;
    readonly onRematch: () => void;
  }

  interface Props {
    outcome: MatchOutcome;
    snapshot: MatchSnapshot;
    /** 相手の表示名(オフラインは「相手(ボット)」、オンラインは「相手」)。 */
    opponentLabel?: string;
    /** リザルト下部の操作プロンプト(オンラインは別の導線にするため差し替え可)。 */
    promptText?: string;
    /** 再戦 UI(#17)。渡された時だけ結果画面に再戦導線を出す。オフラインは未指定。 */
    rematch?: RematchState;
  }

  const {
    outcome,
    snapshot,
    opponentLabel = '相手(ボット)',
    promptText = 'スペースキーで再戦',
    rematch,
  }: Props = $props();

  // 勝敗の見出し(視点は自陣)。outcome.kind は ongoing 以外がここに来る。
  const heading = $derived.by(() => {
    switch (outcome.kind) {
      case 'win':
        return '勝利!';
      case 'lose':
        return '敗北…';
      case 'draw':
        return '引き分け';
      case 'forfeit':
        return '放棄';
      default:
        return '対戦終了';
    }
  });

  // 終了理由の日本語(ADR 0011 #12)。
  function reasonLabel(reason: EndReason): string {
    switch (reason) {
      case 'ko':
        return '撃破';
      case 'timeup':
        return '時間切れ';
      case 'forfeit':
        return '放棄';
      default:
        return '';
    }
  }

  const reason = $derived(outcome.kind === 'ongoing' ? '' : reasonLabel(outcome.endReason));
  const resultClass = $derived(outcome.kind === 'ongoing' ? '' : outcome.kind);
</script>

<div class="stage-viewport">
  <div class="stage">
    <section class="result">
      <h1 class={resultClass}>{heading}</h1>
      {#if reason}
        <div class="reason">{reason}</div>
      {/if}

      <div class="hp-summary">
        <div class="hp-cell">
          <div class="hp-head">
            <span class="label">自分</span>
            <span class="value self">{snapshot.self.hp}/{snapshot.self.maxHp}</span>
          </div>
          <HpBar
            hp={snapshot.self.hp}
            maxHp={snapshot.self.maxHp}
            side="self"
            shield={snapshot.self.shield}
          />
        </div>
        <div class="hp-cell">
          <div class="hp-head">
            <span class="label">{opponentLabel}</span>
            <span class="value opp">{snapshot.opponent.hp}/{snapshot.opponent.maxHp}</span>
          </div>
          <HpBar
            hp={snapshot.opponent.hp}
            maxHp={snapshot.opponent.maxHp}
            side="opponent"
            shield={snapshot.opponent.shield}
          />
        </div>
      </div>

      <p class="prompt">{promptText}</p>

      {#if rematch}
        <div class="rematch">
          {#if rematch.selfRequested}
            <p class="rematch-status">再戦を申し込みました。相手の応答を待っています…</p>
          {:else}
            {#if rematch.opponentRequested}
              <p class="rematch-status highlight">相手が再戦を希望しています!</p>
            {/if}
            <p class="rematch-countdown">{rematch.countdownSeconds}</p>
            <Button variant="primary" onclick={rematch.onRematch}>再戦</Button>
          {/if}
        </div>
      {/if}

      <nav class="nav">
        <Button variant="ghost" href="/deck" onclick={(e) => handleNavClick(e, 'deck')}
          >デッキ編集</Button
        >
        <Button variant="ghost" href="/" onclick={(e) => handleNavClick(e, 'home')}
          >ホームへ戻る</Button
        >
      </nav>
    </section>
  </div>
</div>

<style>
  .result {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 26px;
    padding: 80px;
    background: var(--bg-radial-top);
    font-family: var(--font-body);
    text-align: center;
  }

  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 110px;
    font-weight: 800;
    color: var(--text-heading);
  }

  h1.win {
    color: var(--gold-bright);
    text-shadow: 0 0 60px var(--gold-glow-50);
  }

  h1.lose {
    color: var(--hp-opp-end);
  }

  h1.draw,
  h1.forfeit {
    color: var(--text-faint);
  }

  .reason {
    font-size: 28px;
    color: var(--text-body);
  }

  .hp-summary {
    display: flex;
    gap: 60px;
    width: 640px;
    margin-top: 10px;
  }

  .hp-cell {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .hp-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-family: var(--font-mono);
  }

  .hp-head .label {
    font-size: 22px;
    color: var(--text-faint);
  }

  .hp-head .value {
    font-size: 32px;
    font-weight: 700;
  }

  .value.self {
    color: var(--hp-self-end);
  }

  .value.opp {
    color: var(--hp-opp-end);
  }

  .prompt {
    margin: 10px 0 0;
    font-size: 26px;
    font-weight: 700;
    color: var(--link-purple);
  }

  .rematch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    margin-top: 6px;
  }

  .rematch-status {
    margin: 0;
    font-size: 22px;
    color: var(--text-body);
  }

  .rematch-status.highlight {
    color: var(--gold-bright);
    font-weight: 700;
  }

  .rematch-countdown {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 64px;
    font-weight: 700;
    color: var(--gold-bright);
    text-shadow: 0 0 30px var(--gold-glow-50);
    font-variant-numeric: tabular-nums;
  }

  .nav {
    display: flex;
    gap: 16px;
    margin-top: 16px;
  }
</style>
