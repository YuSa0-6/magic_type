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

  // 新デザイン(夜のアルカナ卓)へ移行済みの画面は自前で全画面ステージを敷くため
  // main の余白を持たない。未移行画面(match/deck/room)は旧デザインの
  // 1rem 余白を前提にしたレイアウトのままなので維持する。
  const isRedesigned = $derived(route === 'game' || route === 'home');
</script>

<main class:bare={isRedesigned}>
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
    padding: 1rem;
    box-sizing: border-box;
    font-family: sans-serif;
    color: #333;
  }

  main.bare {
    padding: 0;
  }
</style>
