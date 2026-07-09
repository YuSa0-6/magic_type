<script lang="ts">
  // HP バー(表示専用)。値の増減判定は持たず、渡された hp/maxHp を幅に反映するだけ。
  // 被弾フラッシュだけは「前回値より減った」という表示上のトリガを内部で検知する。
  interface Props {
    hp: number;
    maxHp: number;
    /** self=緑グラデ / opponent=赤グラデ(タイムアタックの的 HP にも opponent を流用)。 */
    side: 'self' | 'opponent';
  }

  const { hp, maxHp, side }: Props = $props();

  const pct = $derived(maxHp <= 0 ? 0 : Math.max(0, Math.min(100, (hp / maxHp) * 100)));

  // 前回 hp との比較で被弾を検知し、{#key} でフラッシュ要素を貼り直して @keyframes を 1 回再生する。
  // prevHp は描画に使わない履歴なので $state ではなく素の変数で持つ(再描画・依存ループを避ける)。
  let prevHp: number | null = null;
  let flashSeq = $state(0);
  $effect(() => {
    const cur = hp;
    if (prevHp !== null && cur < prevHp) flashSeq += 1;
    prevHp = cur;
  });
</script>

<div class="track">
  <div class="fill {side}" style="width: {pct}%"></div>
  {#key flashSeq}
    {#if flashSeq > 0}<div class="flash"></div>{/if}
  {/key}
</div>

<style>
  .track {
    position: relative;
    width: 100%;
    height: 22px;
    border-radius: 11px;
    background: rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: 11px;
    transition: width 0.3s ease-out;
  }

  .fill.self {
    background: linear-gradient(90deg, var(--hp-self-start), var(--hp-self-end));
    box-shadow: 0 0 12px var(--hp-self-glow);
  }

  .fill.opponent {
    background: linear-gradient(90deg, var(--hp-opp-start), var(--hp-opp-end));
    box-shadow: 0 0 12px var(--hp-opp-glow);
  }

  .flash {
    position: absolute;
    inset: 0;
    border-radius: 11px;
    background: rgba(208, 100, 92, 0.85);
    pointer-events: none;
    animation: hp-flash 0.32s ease-out forwards;
  }

  @keyframes hp-flash {
    from {
      opacity: 0.85;
    }
    to {
      opacity: 0;
    }
  }
</style>
