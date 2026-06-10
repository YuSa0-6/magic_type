<script lang="ts">
  // スタート画面: タイトルと操作説明を表示する。
  // 開始操作(スペースキー)は App 側の window keydown で処理するため、ここでは表示のみ。
</script>

<section class="start">
  <h1>マジックタイピングバトル</h1>
  <div class="desc">
    <p>1〜4キーまたはクリックでカードを選択。</p>
    <p>表示されたお題をタイピングして呪文を詠唱しよう。</p>
    <p>的のHP50を0にするまでの時間を競うタイムアタックです。</p>
  </div>
  <p class="prompt">スペースキーで開始</p>
</section>

<style>
  .start {
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

  .prompt {
    margin-top: 2rem;
    font-size: 1.2rem;
    font-weight: bold;
    color: #1565c0;
  }
</style>
