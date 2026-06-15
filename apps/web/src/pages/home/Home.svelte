<script lang="ts">
  import { navigate, handleNavClick } from '../../lib/router.svelte';

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
    <p>1人で挑むタイムアタックと、相手とHPを削り合う対戦が遊べます。</p>
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
    <a class="menu-item" href="/match" onclick={(e) => handleNavClick(e, 'match')}>
      対戦(vsボット)
    </a>
    <a class="menu-item" href="/room" onclick={(e) => handleNavClick(e, 'room')}>
      オンライン対戦
    </a>
    <a class="menu-item secondary" href="/deck" onclick={(e) => handleNavClick(e, 'deck')}>
      デッキ編集
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

  /* デッキ編集はゲームモードではない補助導線なので控えめにする。 */
  .menu-item.secondary {
    border-color: #888;
    background: #f0f0f0;
    color: #555;
    font-size: 1rem;
    padding: 0.5rem 2rem;
  }

  .menu-item.secondary:hover,
  .menu-item.secondary:focus-visible {
    background: #888;
    color: #fff;
  }
</style>
