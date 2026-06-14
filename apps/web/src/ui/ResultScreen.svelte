<script lang="ts">
  import type { BattleStats } from '@magic/server/engine';
  import { CARDS } from '@magic/server/engine';
  import { handleNavClick } from './router.svelte';

  // リザルト画面: engine.stats() の戻り値をそのまま表に表示する(整形のみ)。
  // 再挑戦操作(スペースキー)は App 側の window keydown で処理する。
  interface Props {
    stats: BattleStats;
    clearTimeMs: number;
  }

  const { stats, clearTimeMs }: Props = $props();

  // カードIDから表示名を引く(なければIDをそのまま使う)。
  const cardName = (id: string): string => CARDS.find((c) => c.id === id)?.name ?? id;

  function formatSeconds(ms: number): string {
    return (ms / 1000).toFixed(1);
  }
</script>

<section class="result">
  <h1>クリア!</h1>
  <div class="clear-time">クリアタイム {formatSeconds(clearTimeMs)}秒</div>
  <div class="total-mistypes">総誤入力数: {stats.totalMistypes}</div>

  <table>
    <thead>
      <tr>
        <th>カード</th>
        <th>発動回数</th>
        <th>平均詠唱時間</th>
        <th>合計ダメージ</th>
      </tr>
    </thead>
    <tbody>
      {#each stats.perCard as stat (stat.cardId)}
        <tr>
          <td>{cardName(stat.cardId)}</td>
          <td>{stat.activations}</td>
          <td>{formatSeconds(stat.averageCastTimeMs)}秒</td>
          <td>{stat.totalDamage}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  <p class="prompt">スペースキーでもう一度</p>
  <nav class="nav">
    <a class="home-link" href="/" onclick={(e) => handleNavClick(e, 'home')}>ホームへ戻る</a>
  </nav>
</section>

<style>
  .result {
    text-align: center;
    font-family: 'Courier New', monospace;
  }

  h1 {
    font-size: 2rem;
    color: #333;
  }

  .clear-time {
    font-size: 2.2rem;
    font-weight: bold;
    color: #1565c0;
    margin: 0.5rem 0;
  }

  .total-mistypes {
    color: #555;
    margin-bottom: 1.5rem;
  }

  table {
    margin: 0 auto 1.5rem;
    border-collapse: collapse;
  }

  th,
  td {
    border: 1px solid #ccc;
    padding: 0.4rem 1rem;
    text-align: right;
  }

  th:first-child,
  td:first-child {
    text-align: left;
  }

  th {
    background: #f0f0f0;
  }

  .prompt {
    font-size: 1.2rem;
    font-weight: bold;
    color: #1565c0;
  }

  .nav {
    margin-top: 1rem;
  }

  .home-link {
    color: #1565c0;
    text-decoration: underline;
    font-family: sans-serif;
  }
</style>
