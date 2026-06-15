<script lang="ts">
  import type { MatchOutcome, MatchSnapshot, EndReason } from '@magic/server/engine';
  import { handleNavClick } from '../../lib/router.svelte';

  // 対戦リザルト画面: 確定した outcome と最終 HP を表示するだけ(整形のみ, ADR 0002)。
  // 再戦操作(スペースキー)は Match 側の window keydown で処理する。
  interface Props {
    outcome: MatchOutcome;
    snapshot: MatchSnapshot;
    /** 相手の表示名(オフラインは「相手(ボット)」、オンラインは「相手」)。 */
    opponentLabel?: string;
    /** リザルト下部の操作プロンプト(オンラインは別の導線にするため差し替え可)。 */
    promptText?: string;
  }

  const {
    outcome,
    snapshot,
    opponentLabel = '相手(ボット)',
    promptText = 'スペースキーで再戦',
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

<section class="result">
  <h1 class={resultClass}>{heading}</h1>
  {#if reason}
    <div class="reason">{reason}</div>
  {/if}

  <div class="hp-summary">
    <div class="hp-cell">
      <div class="label">自分</div>
      <div class="value self">{snapshot.self.hp}/{snapshot.self.maxHp}</div>
    </div>
    <div class="hp-cell">
      <div class="label">{opponentLabel}</div>
      <div class="value opp">{snapshot.opponent.hp}/{snapshot.opponent.maxHp}</div>
    </div>
  </div>

  <p class="prompt">{promptText}</p>
  <nav class="nav">
    <a class="link" href="/deck" onclick={(e) => handleNavClick(e, 'deck')}>デッキ編集</a>
    <a class="link" href="/" onclick={(e) => handleNavClick(e, 'home')}>ホームへ戻る</a>
  </nav>
</section>

<style>
  .result {
    text-align: center;
    font-family: 'Courier New', monospace;
  }

  h1 {
    font-size: 2.2rem;
    margin-bottom: 0.3rem;
  }

  h1.win {
    color: #2e7d32;
  }

  h1.lose {
    color: #c62828;
  }

  h1.draw,
  h1.forfeit {
    color: #777;
  }

  .reason {
    color: #555;
    margin-bottom: 1.5rem;
  }

  .hp-summary {
    display: flex;
    justify-content: center;
    gap: 2.5rem;
    margin-bottom: 1.5rem;
  }

  .label {
    font-size: 0.9rem;
    color: #777;
  }

  .value {
    font-size: 1.8rem;
    font-weight: bold;
  }

  .value.self {
    color: #2e7d32;
  }

  .value.opp {
    color: #c62828;
  }

  .prompt {
    font-size: 1.2rem;
    font-weight: bold;
    color: #1565c0;
  }

  .nav {
    margin-top: 1rem;
    display: flex;
    justify-content: center;
    gap: 1.5rem;
  }

  .link {
    color: #1565c0;
    text-decoration: underline;
    font-family: sans-serif;
  }
</style>
