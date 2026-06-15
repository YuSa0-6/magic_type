<script lang="ts">
  import { navigate, handleNavClick } from '../../lib/router.svelte';

  // ルーム画面(スタブ)。ADR 0011 #6 のルームコード方式の見た目だけを用意する。
  //
  // TODO(B/server): WebSocket + Durable Object の配線はここで行う(ADR 0011 #5/#6/#9)。
  //   - 「部屋を作る」: WS 接続 → DO がルームコードを発行 → コードを表示して相手を待つ。
  //   - 「コードで参加」: 入力コードで WS 接続 → 両者揃ったら対戦開始(サーバー権威 + 自陣予測)。
  //   - デッキは localStorage から読んで接続時に送信、サーバーが合法性を検証(ADR 0011 #7)。
  // v1(本 PR)はサーバーが無いため、いずれのボタンもオフライン対戦(対ボット)へ倒す。

  // 入力中のルームコード(参加用)。スタブなので接続には使わず、見た目のみ。
  let joinCode = $state('');

  // どちらの操作も今はオフライン対戦(対ボット)に入る(WS 配線は B 待ち)。
  function enterOffline(): void {
    navigate('match');
  }
</script>

<section class="room">
  <h1>オンライン対戦</h1>

  <div class="notice" role="note">
    オンライン対戦(ルーム接続)は準備中です。下のボタンは今はボットとのオフライン対戦に入ります。
  </div>

  <div class="panels">
    <div class="panel">
      <h2>部屋を作る</h2>
      <p>部屋を作成してコードを発行し、相手の参加を待ちます。</p>
      <button type="button" class="primary" onclick={enterOffline}>部屋を作る</button>
    </div>

    <div class="panel">
      <h2>コードで参加</h2>
      <p>相手から共有されたルームコードを入力して参加します。</p>
      <input
        type="text"
        placeholder="ルームコード"
        bind:value={joinCode}
        aria-label="ルームコード"
      />
      <button type="button" class="primary" onclick={enterOffline}>参加する</button>
    </div>
  </div>

  <nav class="nav">
    <a class="link" href="/match" onclick={(e) => handleNavClick(e, 'match')}>vsボットで練習</a>
    <a class="link" href="/" onclick={(e) => handleNavClick(e, 'home')}>ホームへ戻る</a>
  </nav>
</section>

<style>
  .room {
    width: 100%;
    max-width: 640px;
    text-align: center;
    font-family: sans-serif;
  }

  h1 {
    font-size: 1.8rem;
    color: #333;
  }

  .notice {
    background: #fff8e1;
    border: 1px solid #f0c36d;
    color: #8a6d00;
    border-radius: 6px;
    padding: 0.6rem 0.9rem;
    margin: 1rem 0 1.5rem;
    font-size: 0.9rem;
  }

  .panels {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .panel {
    flex: 1;
    min-width: 220px;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 1.2rem;
    background: #fafafa;
  }

  h2 {
    font-size: 1.1rem;
    color: #444;
    margin-top: 0;
  }

  .panel p {
    color: #666;
    font-size: 0.9rem;
    min-height: 2.6em;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem;
    border: 1px solid #bbb;
    border-radius: 6px;
    margin-bottom: 0.8rem;
    font-size: 1rem;
  }

  .primary {
    width: 100%;
    padding: 0.6rem;
    border-radius: 6px;
    border: none;
    background: #1565c0;
    color: #fff;
    font-weight: bold;
    font-size: 1rem;
    cursor: pointer;
  }

  .nav {
    margin-top: 1.5rem;
    display: flex;
    justify-content: center;
    gap: 1.5rem;
  }

  .link {
    color: #1565c0;
    text-decoration: underline;
  }
</style>
