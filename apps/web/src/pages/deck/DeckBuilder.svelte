<script lang="ts">
  import { CARDS, EFFECT_CARDS, type Card } from '@magic/server/engine';
  import {
    DECK_SIZE,
    MAX_PER_CARD,
    validateDeck,
    loadDeckIds,
    saveDeckIds,
    defaultDeckIds,
  } from '../../lib/deck-storage';
  import { handleNavClick } from '../../lib/router.svelte';

  // デッキビルダー(ADR 0011 #7)。プール(純攻撃10 + 効果6)から 15枚・同種最大2枚 の
  // デッキを構築し localStorage に保存/読込する。判定・永続化のロジックは lib/deck-storage に
  // 集約し、ここは UI と $state の橋渡しだけを持つ(ADR 0002/0006)。

  // 編集中デッキ(カード ID の配列)。保存済みが正当ならそれ、無ければ既定デッキで初期化する。
  let deck = $state<string[]>(loadDeckIds() ?? defaultDeckIds());

  // 保存結果のフィードバック(数秒で消えるトースト的表示)。
  let savedMessage = $state<string | null>(null);

  // 検証結果(枚数・同種上限・実在カード)。ボタン活性とエラー表示の両方に使う。
  const validation = $derived(validateDeck(deck));

  // ID ごとの枚数マップ($derived で deck から導出。各カードの ± 判定に使う)。
  const counts = $derived.by(() => {
    const m = new Map<string, number>();
    for (const id of deck) {
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  });

  function countOf(id: string): number {
    return counts.get(id) ?? 0;
  }

  // カードを1枚追加する。同種上限・総数上限に達していたら何もしない(ボタンも無効化する)。
  function addCard(card: Card): void {
    if (deck.length >= DECK_SIZE || countOf(card.id) >= MAX_PER_CARD) {
      return;
    }
    deck = [...deck, card.id];
    savedMessage = null;
  }

  // カードを1枚減らす(末尾の同種を1枚除く)。
  function removeCard(card: Card): void {
    const idx = deck.lastIndexOf(card.id);
    if (idx === -1) {
      return;
    }
    deck = [...deck.slice(0, idx), ...deck.slice(idx + 1)];
    savedMessage = null;
  }

  // デッキを保存する。検証が通っていなければ保存しない(ボタンも無効化する)。
  function save(): void {
    if (!validation.valid) {
      return;
    }
    const ok = saveDeckIds(deck);
    savedMessage = ok ? 'デッキを保存しました' : '保存に失敗しました(localStorage が使えません)';
  }

  // 既定デッキ(STARTER_DECK)に戻す。保存は別途ボタンで行う。
  function reset(): void {
    deck = defaultDeckIds();
    savedMessage = null;
  }
</script>

<section class="builder">
  <header>
    <h1>デッキ編集</h1>
    <p class="rule">
      {DECK_SIZE}枚ちょうど・同じカードは最大{MAX_PER_CARD}枚まで。純攻撃カードに加え、効果カードを混ぜられます。
    </p>
  </header>

  <!-- 現在の枚数と検証状況 -->
  <div class="summary" class:ok={validation.valid} class:ng={!validation.valid}>
    <span class="count">{deck.length} / {DECK_SIZE} 枚</span>
    {#if validation.valid}
      <span class="status">構築 OK</span>
    {:else}
      <ul class="errors">
        {#each validation.errors as err (err)}
          <li>{err}</li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="actions">
    <button type="button" class="primary" onclick={save} disabled={!validation.valid}>
      保存
    </button>
    <button type="button" onclick={reset}>既定デッキに戻す</button>
    <a class="link" href="/match" onclick={(e) => handleNavClick(e, 'match')}>対戦へ</a>
    <a class="link" href="/" onclick={(e) => handleNavClick(e, 'home')}>ホームへ</a>
  </div>

  {#if savedMessage}
    <div class="saved" role="status">{savedMessage}</div>
  {/if}

  <!-- 純攻撃カード -->
  <h2>純攻撃カード</h2>
  <div class="pool">
    {#each CARDS as card (card.id)}
      {@const n = countOf(card.id)}
      <div class="pool-card" class:in-deck={n > 0}>
        <div class="pc-head">
          <span class="pc-name">{card.name}</span>
          <span class="pc-count">{n}/{MAX_PER_CARD}</span>
        </div>
        <div class="pc-text">{card.displayText}</div>
        <div class="pc-meta">ダメージ {card.damage}</div>
        <div class="pc-buttons">
          <button type="button" onclick={() => removeCard(card)} disabled={n === 0}>−</button>
          <button
            type="button"
            onclick={() => addCard(card)}
            disabled={n >= MAX_PER_CARD || deck.length >= DECK_SIZE}>＋</button
          >
        </div>
      </div>
    {/each}
  </div>

  <!-- 効果カード -->
  <h2>効果カード</h2>
  <div class="pool">
    {#each EFFECT_CARDS as card (card.id)}
      {@const n = countOf(card.id)}
      <div class="pool-card effect" class:in-deck={n > 0}>
        <div class="pc-head">
          <span class="pc-name">{card.name}</span>
          <span class="pc-count">{n}/{MAX_PER_CARD}</span>
        </div>
        <div class="pc-text">{card.displayText}</div>
        <div class="pc-meta">ダメージ {card.damage}・効果あり</div>
        <div class="pc-buttons">
          <button type="button" onclick={() => removeCard(card)} disabled={n === 0}>−</button>
          <button
            type="button"
            onclick={() => addCard(card)}
            disabled={n >= MAX_PER_CARD || deck.length >= DECK_SIZE}>＋</button
          >
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  .builder {
    width: 100%;
    max-width: 760px;
    font-family: sans-serif;
  }

  header {
    text-align: center;
  }

  h1 {
    font-size: 1.8rem;
    color: #333;
    margin-bottom: 0.2rem;
  }

  .rule {
    color: #777;
    font-size: 0.9rem;
    margin-top: 0;
  }

  .summary {
    border-radius: 8px;
    padding: 0.6rem 1rem;
    margin: 1rem 0;
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .summary.ok {
    background: #e8f5e9;
    border: 1px solid #a5d6a7;
  }

  .summary.ng {
    background: #fff8e1;
    border: 1px solid #f0c36d;
  }

  .count {
    font-weight: bold;
    font-size: 1.1rem;
  }

  .status {
    color: #2e7d32;
    font-weight: bold;
  }

  .errors {
    margin: 0;
    padding-left: 1.2rem;
    color: #8a6d00;
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
  }

  .actions button {
    padding: 0.5rem 1.2rem;
    border-radius: 6px;
    border: 1px solid #bbb;
    background: #fff;
    cursor: pointer;
    font-size: 0.95rem;
  }

  .actions button.primary {
    border-color: #1565c0;
    background: #1565c0;
    color: #fff;
    font-weight: bold;
  }

  .actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .link {
    color: #1565c0;
    text-decoration: underline;
  }

  .saved {
    background: #e3f2fd;
    border: 1px solid #90caf9;
    border-radius: 6px;
    padding: 0.4rem 0.8rem;
    color: #1565c0;
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
  }

  h2 {
    font-size: 1.1rem;
    color: #444;
    margin: 1.2rem 0 0.5rem;
    border-bottom: 1px solid #eee;
    padding-bottom: 0.2rem;
  }

  .pool {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.6rem;
  }

  .pool-card {
    border: 2px solid #ddd;
    border-radius: 6px;
    padding: 0.6rem;
    background: #fafafa;
  }

  .pool-card.effect {
    background: #faf5ff;
  }

  .pool-card.in-deck {
    border-color: #1565c0;
  }

  .pc-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .pc-name {
    font-weight: bold;
  }

  .pc-count {
    font-size: 0.8rem;
    color: #777;
  }

  .pc-text {
    font-size: 0.8rem;
    color: #555;
    margin: 0.3rem 0;
    min-height: 2.2em;
  }

  .pc-meta {
    font-size: 0.8rem;
    color: #777;
    margin-bottom: 0.4rem;
  }

  .pc-buttons {
    display: flex;
    gap: 0.4rem;
  }

  .pc-buttons button {
    flex: 1;
    padding: 0.3rem 0;
    border-radius: 4px;
    border: 1px solid #bbb;
    background: #fff;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }

  .pc-buttons button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
