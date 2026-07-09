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

<div class="stage-viewport">
  <div class="stage">
    <section class="home">
      <div class="brand">
        <div class="emblem" aria-hidden="true"><span class="emblem-mark">&#10022;</span></div>
        <h1>マジックタイピングバトル</h1>
        <div class="desc">
          <p>カードを選んでお題をタイピングし、呪文を詠唱して的を倒す。</p>
          <p>1人で挑むタイムアタックと、相手とHPを削り合う対戦が遊べます。</p>
        </div>
      </div>

      <nav class="menu">
        <a
          class="menu-item featured"
          href="/game"
          onclick={(e) => handleNavClick(e, 'game')}
          onkeydown={handleMenuKeydown}
        >
          <span class="menu-icon">&#9889;</span>
          <span class="menu-text">
            <span class="menu-title">タイムアタック</span>
            <span class="menu-sub">ベスト 記録なし</span>
          </span>
          <span class="menu-key">Enter</span>
        </a>
        <a class="menu-item" href="/match" onclick={(e) => handleNavClick(e, 'match')}>
          <span class="menu-icon">&#9876;&#65039;</span>
          <span class="menu-text">
            <span class="menu-title">対戦(vsボット)</span>
            <span class="menu-sub">練習に最適</span>
          </span>
        </a>
        <a class="menu-item" href="/room" onclick={(e) => handleNavClick(e, 'room')}>
          <span class="menu-icon">&#127760;</span>
          <span class="menu-text">
            <span class="menu-title">オンライン対戦</span>
            <span class="menu-sub">ルームコードで招待</span>
          </span>
        </a>
        <a class="menu-item dashed" href="/deck" onclick={(e) => handleNavClick(e, 'deck')}>
          <span class="menu-icon menu-icon-small">&#128214;</span>
          <span class="menu-text-inline">デッキ編集</span>
          <span class="menu-note">カード構成を確認・編集</span>
        </a>

        <p class="menu-hint">↑↓で選択 / Enterで決定</p>
      </nav>
    </section>
  </div>
</div>

<style>
  .home {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 140px;
    padding: 80px;
    background: var(--bg-radial-top);
    font-family: var(--font-body);
  }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 36px;
    text-align: center;
  }

  .emblem {
    width: 220px;
    height: 220px;
    flex: none;
    border-radius: 50%;
    border: 3px solid var(--gold);
    box-shadow:
      0 0 60px rgba(201, 163, 90, 0.35),
      inset 0 0 40px rgba(201, 163, 90, 0.2);
    background: repeating-linear-gradient(-45deg, #241d40 0 10px, #2a2249 10px 20px);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .emblem-mark {
    font-size: 64px;
    line-height: 1;
    color: var(--gold);
  }

  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 76px;
    font-weight: 800;
    letter-spacing: 0.06em;
    color: var(--text-heading);
    text-shadow: 0 0 40px rgba(122, 111, 196, 0.55);
  }

  .desc {
    max-width: 560px;
    color: var(--text-body);
    font-size: 24px;
    line-height: 1.7;
  }

  .desc p {
    margin: 0.2em 0;
  }

  .menu {
    display: flex;
    flex-direction: column;
    gap: 24px;
    width: 520px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 22px;
    padding: 30px 36px;
    border: 2px solid var(--purple-border);
    border-radius: var(--radius-panel);
    background: rgba(122, 111, 196, 0.08);
    text-decoration: none;
    transition:
      transform 0.15s ease-out,
      box-shadow 0.15s ease-out;
  }

  .menu-item:hover,
  .menu-item:focus-visible {
    transform: translateX(6px);
    box-shadow: 0 0 22px rgba(122, 111, 196, 0.35);
    outline: none;
  }

  .menu-item.featured {
    border-color: var(--gold);
    background: linear-gradient(100deg, rgba(201, 163, 90, 0.18), rgba(201, 163, 90, 0.06));
    box-shadow: 0 0 28px rgba(201, 163, 90, 0.18);
  }

  .menu-item.featured:hover,
  .menu-item.featured:focus-visible {
    box-shadow: 0 0 34px var(--gold-glow-50);
  }

  .menu-icon {
    flex: none;
    font-size: 40px;
    line-height: 1;
  }

  .menu-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .menu-title {
    font-family: var(--font-serif);
    font-size: 34px;
    font-weight: 700;
    color: var(--text-heading);
  }

  .menu-sub {
    font-size: 22px;
    color: var(--text-body);
  }

  .menu-key {
    flex: none;
    font-family: var(--font-mono);
    font-size: 22px;
    color: var(--gold);
    border: 1.5px solid var(--gold);
    border-radius: 8px;
    padding: 4px 14px;
  }

  /* デッキ編集はゲームモードではない補助導線なので控えめにする(破線枠・見出しフォントも本文扱い)。 */
  .menu-item.dashed {
    padding: 22px 36px;
    border-style: dashed;
    border-color: var(--border-dim);
    background: transparent;
    color: var(--text-body);
  }

  .menu-item.dashed:hover,
  .menu-item.dashed:focus-visible {
    border-color: var(--purple-border);
    box-shadow: 0 0 18px rgba(122, 111, 196, 0.25);
  }

  .menu-icon-small {
    font-size: 32px;
  }

  .menu-text-inline {
    flex: 1;
    font-size: 28px;
  }

  .menu-note {
    flex: none;
    font-size: 22px;
    color: var(--text-faint);
  }

  .menu-hint {
    margin: 0;
    text-align: center;
    font-size: 22px;
    color: var(--text-faintest);
  }
</style>
