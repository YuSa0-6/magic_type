<script lang="ts">
  import { getRoute } from './lib/router.svelte';
  import Home from './pages/home/Home.svelte';
  import Game from './pages/game/Game.svelte';
  import Match from './pages/match/Match.svelte';
  import DeckBuilder from './pages/deck/DeckBuilder.svelte';
  import Room from './pages/room/Room.svelte';

  // ルートで画面を出し分けるだけの構成(ADR 0002: UIは薄い皮)。
  // クライアントルーティング(History API)の正は router.svelte.ts。
  const route = $derived(getRoute());
</script>

<main>
  {#if route === 'game'}
    <Game />
  {:else if route === 'match'}
    <Match />
  {:else if route === 'deck'}
    <DeckBuilder />
  {:else if route === 'room'}
    <Room />
  {:else}
    <Home />
  {/if}
</main>

<style>
  /* OSのダークモードに引きずられないよう背景色を明示する */
  :global(body) {
    margin: 0;
    background: #fafafa;
  }

  main {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 0;
    box-sizing: border-box;
    font-family: sans-serif;
    color: #333;
  }
</style>
