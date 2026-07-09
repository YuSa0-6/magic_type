<script lang="ts">
  import type { Snippet } from 'svelte';

  // 汎用アクションボタン。ルーターへは依存せず、href 指定時は <a> として描画し
  // 遷移の制御は呼び出し側の onclick(handleNavClick 等)に委ねる(ADR 0006)。
  interface Props {
    variant: 'primary' | 'secondary' | 'ghost';
    type?: 'button' | 'submit';
    disabled?: boolean;
    href?: string;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
  }

  const { variant, type = 'button', disabled = false, href, onclick, children }: Props = $props();
</script>

{#if href}
  <a class="btn {variant}" class:disabled {href} {onclick}>{@render children()}</a>
{:else}
  <button class="btn {variant}" {type} {disabled} {onclick}>{@render children()}</button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    box-sizing: border-box;
    font-family: var(--font-body);
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
    transition:
      transform 0.12s ease-out,
      box-shadow 0.12s ease-out,
      filter 0.12s ease-out;
  }

  .btn:disabled,
  .btn.disabled {
    cursor: default;
    opacity: 0.45;
    pointer-events: none;
  }

  .primary {
    padding: 16px 40px;
    font-size: 26px;
    color: var(--text-heading);
    border: none;
    border-radius: var(--radius-panel);
    background: linear-gradient(160deg, var(--purple-grad-start), var(--purple-grad-end));
    box-shadow: 0 0 22px rgba(122, 111, 196, 0.35);
  }

  .primary:hover,
  .primary:focus-visible {
    transform: translateY(-2px);
    box-shadow: 0 0 30px rgba(122, 111, 196, 0.5);
    outline: none;
  }

  .secondary {
    padding: 14px 34px;
    font-size: 24px;
    color: var(--gold-bright);
    border: 2px solid var(--gold);
    border-radius: var(--radius-panel);
    background: transparent;
  }

  .secondary:hover,
  .secondary:focus-visible {
    box-shadow: 0 0 22px var(--gold-glow-25);
    outline: none;
  }

  .ghost {
    padding: 8px 6px;
    font-size: 22px;
    color: var(--link-purple);
    border: none;
    background: transparent;
    text-decoration: underline;
    text-underline-offset: 4px;
  }

  .ghost:hover,
  .ghost:focus-visible {
    color: var(--text-heading);
    outline: none;
  }
</style>
