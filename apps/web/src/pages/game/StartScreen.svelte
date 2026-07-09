<script lang="ts">
  // 準備画面: 操作説明と開始キーの案内を表示する。
  // タイトルはホームにあるため、ここでは重複表示しない。
  // 開始操作(スペースキー)は Game 側の window keydown で処理するため、ここでは表示のみ。
</script>

<section class="start">
  <div class="desc">
    <p>1〜4キーまたはクリックでカードを選択。</p>
    <p>表示されたお題をタイピングして呪文を詠唱しよう。</p>
    <p>的のHP50を0にするまでの時間を競うタイムアタックです。</p>
  </div>
  <p class="prompt">スペースキーで開始</p>
</section>

<style>
  .start {
    padding: 1rem;
    box-sizing: border-box;
    text-align: center;
  }

  .desc {
    margin: 1.5rem 0;
    color: #555;
    line-height: 1.7;
  }

  .desc p {
    margin: 0.2rem 0;
  }

  .prompt {
    margin-top: 2rem;
    font-size: 1.2rem;
    font-weight: bold;
    color: #1565c0;
  }
</style>
