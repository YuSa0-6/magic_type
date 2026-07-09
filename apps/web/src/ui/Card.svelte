<script lang="ts">
  import type { Card as CardModel } from '@magic/server/engine';
  import { effectCardText } from '../lib/card-format';

  // タイピングカードの表示部品。判定はせず、状態(選択/詠唱/CD 進捗)は props で受け取る(ADR 0006)。
  interface Props {
    /** face='back'(伏せ札)のときは省略可。 */
    card?: CardModel;
    face: 'front' | 'back';
    /** 自陣手札の選択中(浮上+紫枠)。 */
    selected?: boolean;
    /** 相手の詠唱中カード(赤枠+発光+飛び出し)。 */
    casting?: boolean;
    /** クールダウンの回復進捗 0〜1。undefined/0/1 ならゲージ非表示。1 に近いほど回復済み。 */
    cooldownProgress?: number;
    /** デッキ編集時のみ: 所持枚数(n/max バッジ)。 */
    deckCount?: number;
    maxPerCard?: number;
    /** 手札の扇配置用の回転角(呼び出し側が算出)。 */
    rotateDeg?: number;
    /** カード幅(px)。高さは aspect-ratio:5/7 で自動。 */
    width?: number;
    interactive?: boolean;
    onSelect?: () => void;
  }

  const {
    card,
    face,
    selected = false,
    casting = false,
    cooldownProgress,
    deckCount,
    maxPerCard = 2,
    rotateDeg = 0,
    width = 150,
    interactive = false,
    onSelect,
  }: Props = $props();

  const isEffect = $derived((card?.effects.length ?? 0) > 0);
  const effectText = $derived(card ? effectCardText(card.effects) : null);

  // CD 回復中(0<progress<1)のみゲージを出す。満了(1)や未クールダウン(undefined)は通常表示。
  const cooling = $derived(
    cooldownProgress !== undefined && cooldownProgress > 0 && cooldownProgress < 1
  );
  const gaugePct = $derived(
    cooling ? Math.max(0, Math.min(100, Math.round((cooldownProgress ?? 0) * 100))) : 0
  );
  // 下から羊皮紙色が pct% まで登り、上はグレー。fill 色は効果カードだけ金味の羊皮紙。
  const gaugeBg = $derived(
    `linear-gradient(to top, ${isEffect ? 'var(--parchment-gold-start)' : 'var(--parchment-start)'} 0 ${gaugePct}%, #c8c2ce ${gaugePct}% 100%)`
  );

  const rootStyle = $derived(
    `--rot:${rotateDeg}deg;width:${width}px;` + (cooling ? `background:${gaugeBg};` : '')
  );

  // CD 満了(回復中→非回復)を検知して 1 回だけ白フラッシュ。prev は素の変数で持つ(再描画に使わない)。
  let prevCooling = false;
  let flashSeq = $state(0);
  $effect(() => {
    const now = cooling;
    if (prevCooling && !now) flashSeq += 1;
    prevCooling = now;
  });

  const deckBadgeClass = $derived(
    deckCount !== undefined && deckCount >= maxPerCard ? 'full' : isEffect ? 'effect' : 'normal'
  );
</script>

{#snippet inner()}
  {#if face === 'back'}
    <span class="ring" class:casting></span>
  {:else if card}
    {#if deckCount !== undefined}
      <span class="deck-badge {deckBadgeClass}">{deckCount}/{maxPerCard}</span>
    {/if}
    <span class="name">{card.name}</span>
    {#if effectText}<span class="effect-text">{effectText}</span>{/if}
    <span class="gem atk">{card.damage}</span>
    <span class="gem len">{card.reading.length}</span>
  {/if}

  {#key flashSeq}
    {#if flashSeq > 0}<span class="cd-flash"></span>{/if}
  {/key}
{/snippet}

{#if interactive}
  <button
    type="button"
    class="card {face}"
    class:effect={isEffect}
    class:selected
    class:casting
    class:cooling
    class:interactive
    style={rootStyle}
    aria-label={card?.name}
    onclick={onSelect}
  >
    {@render inner()}
  </button>
{:else}
  <div
    class="card {face}"
    class:effect={isEffect}
    class:selected
    class:casting
    class:cooling
    style={rootStyle}
  >
    {@render inner()}
  </div>
{/if}

<style>
  .card {
    position: relative;
    box-sizing: border-box;
    aspect-ratio: 5 / 7;
    border-radius: var(--radius-card);
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-family: var(--font-body);
    transform: rotate(var(--rot)) translateY(0);
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.4);
    transition:
      transform 0.15s ease-out,
      box-shadow 0.15s;
  }

  .card.interactive {
    cursor: pointer;
  }

  /* 前面: 通常カード=羊皮紙+グレー枠 / 効果カード=金味の羊皮紙+金枠。 */
  .card.front {
    border: var(--card-border-w) solid var(--border-card);
    background: linear-gradient(180deg, var(--parchment-start), var(--parchment-end));
  }

  .card.front.effect {
    border-color: var(--gold);
    background: linear-gradient(180deg, var(--parchment-gold-start), var(--parchment-gold-end));
  }

  /* 伏せ札: 紺のストライプ+中央の金の円環。 */
  .card.back {
    border: var(--card-border-w) solid var(--border-dim);
    background: repeating-linear-gradient(-45deg, #241d40 0 9px, #2a2249 9px 18px);
  }

  .ring {
    width: 34%;
    aspect-ratio: 1;
    border-radius: 50%;
    border: 2px solid var(--gold);
    opacity: 0.6;
  }

  .name {
    font-family: var(--font-serif);
    font-size: 32px;
    font-weight: 700;
    color: var(--parchment-text);
    text-align: center;
    line-height: 1.1;
  }

  .card.effect .name {
    color: var(--parchment-effect-text);
  }

  .effect-text {
    font-size: 20px;
    color: var(--parchment-effect-text);
  }

  /* CD 中はカード面がゲージ(inline background)になり、文字はグレーに落とす。 */
  .card.cooling .name,
  .card.cooling .effect-text {
    color: #8a8194;
  }

  .gem {
    position: absolute;
    bottom: -14px;
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 22px;
    font-weight: 700;
    color: #fff;
  }

  .gem.atk {
    left: -12px;
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
    background: linear-gradient(180deg, var(--gem-atk-start), var(--gem-atk-end));
  }

  .gem.len {
    right: -12px;
    border-radius: 50%;
    background: linear-gradient(180deg, var(--gem-len-start), var(--gem-len-end));
  }

  .deck-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    font-family: var(--font-mono);
    font-size: 20px;
    line-height: 1;
    padding: 2px 8px;
    border-radius: 6px;
    background: #fff;
  }

  .deck-badge.normal {
    color: var(--parchment-text-sub);
    border: 1.5px solid var(--romaji-remaining);
  }

  .deck-badge.effect {
    color: var(--parchment-effect-text);
    border: 1.5px solid var(--gold);
  }

  .deck-badge.full {
    color: var(--gem-len-end);
    border: 1.5px solid var(--purple-border);
    font-weight: 700;
  }

  /* ホバー(選択・詠唱中でない前面の操作可能カードのみ): 半分の高さだけ浮く。 */
  .card.front.interactive:not(.selected):not(.casting):hover {
    transform: rotate(var(--rot)) translateY(-16px);
  }

  .card.selected {
    border: var(--card-border-w-selected) solid var(--purple-border);
    transform: rotate(var(--rot)) translateY(-34px);
    box-shadow:
      0 0 0 3px rgba(122, 111, 196, 0.4),
      0 22px 30px rgba(0, 0, 0, 0.55),
      0 0 30px rgba(122, 111, 196, 0.45);
  }

  .card.casting {
    border-color: var(--gem-atk-start);
    transform: rotate(var(--rot)) translateY(12px);
    box-shadow:
      0 8px 18px rgba(0, 0, 0, 0.4),
      0 0 22px rgba(208, 100, 92, 0.5);
  }

  .ring.casting {
    border-color: var(--gem-atk-start);
    opacity: 1;
  }

  .cd-flash {
    position: absolute;
    inset: 0;
    border-radius: var(--radius-card);
    background: #fff;
    pointer-events: none;
    animation: cd-flash 0.35s ease-out forwards;
  }

  @keyframes cd-flash {
    from {
      opacity: 0.85;
    }
    to {
      opacity: 0;
    }
  }
</style>
