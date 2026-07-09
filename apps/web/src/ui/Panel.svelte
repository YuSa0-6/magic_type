<script lang="ts">
  import type { Snippet } from 'svelte';

  // 枠付きパネルの外殻。中身は呼び出し側の Snippet。装飾のみを担い判定は持たない。
  interface Props {
    variant: 'parchment' | 'gold' | 'purple' | 'dashed';
    children: Snippet;
  }

  const { variant, children }: Props = $props();
</script>

<div class="panel {variant}">{@render children()}</div>

<style>
  .panel {
    box-sizing: border-box;
    border-radius: var(--radius-panel);
  }

  /* 詠唱枠。羊皮紙 + 金の二重枠 + 金の発光。 */
  .parchment {
    background: linear-gradient(180deg, var(--parchment-start), var(--parchment-end));
    border: 4px double var(--gold);
    box-shadow:
      0 0 34px var(--gold-glow-25),
      inset 0 0 30px rgba(201, 163, 90, 0.12);
  }

  .gold {
    background: rgba(201, 163, 90, 0.06);
    border: 2px solid var(--gold);
    box-shadow: 0 0 22px var(--gold-glow-25);
  }

  .purple {
    background: rgba(122, 111, 196, 0.08);
    border: 2px solid var(--purple-border);
    box-shadow: 0 0 22px rgba(122, 111, 196, 0.3);
  }

  .dashed {
    background: transparent;
    border: 2px dashed var(--border-dim);
  }
</style>
