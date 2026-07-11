<script lang="ts">
  // 開始カウントダウンの中央演出(ADR 0002: 表示専用の薄い皮)。秒送りは親(pages 層)が
  // value を差し替えて駆動する。金の円環+明朝の数字/「詠唱開始!」を出すだけ。
  interface Props {
    /** 3,2,1 の数字、または 'go'(詠唱開始!)。 */
    value: number | 'go';
  }

  const { value }: Props = $props();
</script>

<!-- 盤面の上に重ねる純粋な演出レイヤー。pointer-events:none でクリックを透過させる
     (ミュートボタン等は素通しにする。カード選択操作自体は呼び出し側 pages が
     phase==='countdown' の間ブロック済みなので、ここで吸収する必要はない)。
     装飾なので支援技術には読ませない(短時間で切り替わり読み上げが雑音になるため)。 -->
<div class="overlay" aria-hidden="true">
  <!-- value が変わるたびに要素を貼り直してスケールイン keyframes を再生する
       (rAF 不使用, ADR 0008)。同じ value が連続しない前提。 -->
  {#key value}
    <div class="ring" class:go={value === 'go'}>
      {#if value === 'go'}詠唱開始!{:else}{value}{/if}
    </div>
  {/key}
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .ring {
    box-sizing: border-box;
    width: 280px;
    height: 280px;
    border-radius: 50%;
    border: 3px solid var(--gold);
    box-shadow:
      0 0 80px rgba(201, 163, 90, 0.4),
      inset 0 0 50px rgba(201, 163, 90, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-serif);
    font-size: 150px;
    font-weight: 800;
    color: var(--text-heading);
    text-shadow: 0 0 40px rgba(201, 163, 90, 0.8);
    animation: countdown-in 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.15) both;
  }

  /* 「詠唱開始!」は数字より小さく、円環内に一行で収める。 */
  .ring.go {
    font-size: 58px;
    font-weight: 700;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  @keyframes countdown-in {
    from {
      transform: scale(0.4);
      opacity: 0;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }
</style>
