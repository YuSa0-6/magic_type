<script lang="ts">
  import type { BattleStats } from '@magic/server/engine';
  import { CARDS } from '@magic/server/engine';
  import { handleNavClick } from '../../lib/router.svelte';
  import Button from '../../ui/Button.svelte';
  import Panel from '../../ui/Panel.svelte';

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

<div class="stage-viewport">
  <div class="stage">
    <section class="result">
      <div class="left">
        <h1>クリア!</h1>
        <div class="clear-time">
          <span class="label">クリアタイム</span>
          <span class="value">{formatSeconds(clearTimeMs)}秒</span>
        </div>
        <p class="prompt">スペースキーでもう一度</p>
        <Button variant="ghost" href="/" onclick={(e) => handleNavClick(e, 'home')}
          >ホームへ戻る</Button
        >
      </div>

      <div class="right">
        <h2>詠唱の記録</h2>
        <div class="record-panel">
          <Panel variant="parchment">
            <div class="record">
              <table class="record-grid">
                <thead>
                  <tr>
                    <th>カード</th>
                    <th class="num">回数</th>
                    <th class="num">平均詠唱</th>
                    <th class="num">DMG</th>
                  </tr>
                </thead>
                <tbody>
                  {#each stats.perCard as stat (stat.cardId)}
                    <tr>
                      <td class="name">{cardName(stat.cardId)}</td>
                      <td class="num">{stat.activations}</td>
                      <td class="num">{formatSeconds(stat.averageCastTimeMs)}秒</td>
                      <td class="num">{stat.totalDamage}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <div class="record-footer">総誤入力 {stats.totalMistypes}</div>
            </div>
          </Panel>
        </div>
      </div>
    </section>
  </div>
</div>

<style>
  .result {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 120px;
    padding: 80px;
    background: var(--bg-radial-top);
    font-family: var(--font-body);
  }

  .left {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 26px;
    text-align: center;
  }

  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 110px;
    font-weight: 800;
    color: var(--gold-bright);
    text-shadow: 0 0 60px var(--gold-glow-50);
  }

  .clear-time {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .clear-time .label {
    font-size: 22px;
    color: var(--text-faint);
  }

  .clear-time .value {
    font-family: var(--font-mono);
    font-size: 44px;
    font-weight: 700;
    color: var(--text-heading);
  }

  .prompt {
    margin: 10px 0 0;
    font-size: 26px;
    font-weight: 700;
    color: var(--link-purple);
  }

  .right {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
  }

  .right h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 34px;
    font-weight: 700;
    color: var(--text-heading);
  }

  .record-panel {
    width: 640px;
  }

  .record {
    padding: 30px 40px;
    color: var(--parchment-text);
  }

  .record-grid {
    width: 100%;
    border-collapse: collapse;
    font-size: 26px;
  }

  .record-grid th,
  .record-grid td {
    padding: 7px 0;
    text-align: left;
    font-weight: 400;
  }

  .record-grid th {
    font-size: 22px;
    color: var(--parchment-text-sub);
  }

  .record-grid th.num,
  .record-grid td.num {
    text-align: right;
  }

  .record-grid td.name {
    font-family: var(--font-serif);
    font-weight: 700;
  }

  .record-grid td.num {
    font-family: var(--font-mono);
  }

  .record-grid th:nth-child(2),
  .record-grid td:nth-child(2) {
    width: 110px;
  }

  .record-grid th:nth-child(3),
  .record-grid td:nth-child(3) {
    width: 150px;
  }

  .record-grid th:nth-child(4),
  .record-grid td:nth-child(4) {
    width: 110px;
  }

  .record-footer {
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1.5px solid rgba(43, 36, 56, 0.2);
    text-align: center;
    font-size: 24px;
    color: var(--parchment-text-sub);
  }
</style>
