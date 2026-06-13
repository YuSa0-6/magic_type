<script lang="ts">
  import { navigate, handleNavClick } from './router.svelte';

  // ホーム画面: タイトル・ゲーム説明・メニューを表示する。
  // ここではタイピング用のキー捕捉をしない(英字キー等を奪わない)。
  // アンカーは Enter でネイティブに発火(onclick 経由で遷移)するため、ここでは Space のみ拾う。
  function handleMenuKeydown(e: KeyboardEvent): void {
    if (e.key === ' ') {
      // Space でのページスクロール等を抑止して遷移に倒す。
      e.preventDefault();
      navigate('game');
    }
  }
</script>

<section class="home">
  <h1>マジックタイピングバトル</h1>
  <div class="desc">
    <p>カードを選んでお題をタイピングし、呪文を詠唱して的を倒す。</p>
    <p>的のHP50を0にするまでの時間を競うタイムアタックです。</p>
  </div>

  <nav class="menu">
    <a
      class="menu-item"
      href="/game"
      onclick={(e) => handleNavClick(e, 'game')}
      onkeydown={handleMenuKeydown}
    >
      タイムアタック
    </a>
  </nav>
</section>

<style>
  .home {
    text-align: center;
  }

  h1 {
    font-size: 2rem;
    color: #333;
  }

  .desc {
    margin: 1.5rem 0;
    color: #555;
    line-height: 1.7;
  }

  .desc p {
    margin: 0.2rem 0;
  }

  .menu {
    margin-top: 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .menu-item {
    display: inline-block;
    padding: 0.7rem 2.5rem;
    border: 2px solid #1565c0;
    border-radius: 6px;
    background: #e3f2fd;
    color: #1565c0;
    font-size: 1.2rem;
    font-weight: bold;
    text-decoration: none;
  }

  .menu-item:hover,
  .menu-item:focus-visible {
    background: #1565c0;
    color: #fff;
    outline: none;
  }
</style>
