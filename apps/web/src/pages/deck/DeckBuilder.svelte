<script lang="ts">
  import { CARDS, EFFECT_CARDS, QUICK_CARDS, type Card as CardModel } from '@magic/server/engine';
  import {
    DECK_SIZE,
    MAX_PER_CARD,
    validateDeck,
    loadDeckIds,
    saveDeckIds,
    defaultDeckIds,
    cardById,
  } from '../../lib/deck-storage';
  import { handleNavClick } from '../../lib/router.svelte';
  import Card from '../../ui/Card.svelte';
  import Panel from '../../ui/Panel.svelte';
  import Button from '../../ui/Button.svelte';

  // デッキビルダー(ADR 0011 #7)。プール(純攻撃10 + 効果6 + クイック5)から 15枚・同種最大2枚 の
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
  function addCard(card: CardModel): void {
    if (deck.length >= DECK_SIZE || countOf(card.id) >= MAX_PER_CARD) {
      return;
    }
    deck = [...deck, card.id];
    savedMessage = null;
  }

  // カードを1枚減らす(末尾の同種を1枚除く)。
  function removeCard(card: CardModel): void {
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

  // --- 表示専用: フィルタピル(pages 層の UI 状態。検証・永続化ロジックには一切関与しない) ---

  type Category = 'attack' | 'effect' | 'quick';
  type FilterValue = 'all' | Category;

  // 3プールを結合した表示用配列。各カードにカテゴリタグを付与してフィルタ対象にする。
  const POOL: readonly { card: CardModel; category: Category }[] = [
    ...CARDS.map((card) => ({ card, category: 'attack' as const })),
    ...EFFECT_CARDS.map((card) => ({ card, category: 'effect' as const })),
    ...QUICK_CARDS.map((card) => ({ card, category: 'quick' as const })),
  ];

  const FILTERS: readonly { value: FilterValue; label: string }[] = [
    { value: 'all', label: 'すべて' },
    { value: 'attack', label: '攻撃' },
    { value: 'effect', label: '効果' },
    { value: 'quick', label: 'クイック' },
  ];

  let filter = $state<FilterValue>('all');

  const filteredPool = $derived(
    filter === 'all' ? POOL : POOL.filter((p) => p.category === filter)
  );

  // デッキ内容の頭文字チップ(表示専用)。プールに実在しない ID は '?' にフォールバックする。
  function chipLabel(id: string): string {
    return cardById(id)?.name.charAt(0) ?? '?';
  }

  function chipIsEffect(id: string): boolean {
    return (cardById(id)?.effects.length ?? 0) > 0;
  }
</script>

<div class="stage-viewport">
  <div class="stage">
    <section class="builder">
      <div class="top">
        <h1>デッキ編集</h1>
        <div class="pills" role="group" aria-label="カードの絞り込み">
          {#each FILTERS as f (f.value)}
            <button
              type="button"
              class="pill {f.value}"
              class:active={filter === f.value}
              onclick={() => (filter = f.value)}
            >
              {f.label}
            </button>
          {/each}
        </div>
        <p class="rule">
          {DECK_SIZE}枚・同種{MAX_PER_CARD}枚まで
        </p>
      </div>

      <div class="grid">
        {#each filteredPool as { card } (card.id)}
          {@const n = countOf(card.id)}
          <div class="pool-item" class:full={n >= MAX_PER_CARD}>
            <Card
              {card}
              face="front"
              interactive={false}
              width={172}
              deckCount={n}
              maxPerCard={MAX_PER_CARD}
            />
            <div class="pc-buttons">
              <button
                type="button"
                class="pc-btn"
                onclick={() => removeCard(card)}
                disabled={n === 0}
                aria-label="{card.name}を1枚減らす">−</button
              >
              <button
                type="button"
                class="pc-btn"
                onclick={() => addCard(card)}
                disabled={n >= MAX_PER_CARD || deck.length >= DECK_SIZE}
                aria-label="{card.name}を1枚増やす">＋</button
              >
            </div>
          </div>
        {/each}
      </div>

      <Panel variant="purple">
        <div class="tray">
          <div class="tray-status">
            <span class="tray-count">{deck.length}/{DECK_SIZE}</span>
            {#if validation.valid}
              <span class="tray-ok">構築OK</span>
            {:else}
              <span class="tray-ng">{validation.errors.join('・')}</span>
            {/if}
          </div>
          <div class="tray-chips">
            {#each deck as id, i (i + ':' + id)}
              <span class="chip" class:gold={chipIsEffect(id)}>{chipLabel(id)}</span>
            {/each}
          </div>
          <div class="tray-actions">
            <Button variant="primary" onclick={save} disabled={!validation.valid}>保存</Button>
            <Button variant="secondary" onclick={reset}>既定に戻す</Button>
          </div>
        </div>
      </Panel>

      {#if savedMessage}
        <p class="saved" role="status">{savedMessage}</p>
      {/if}

      <nav class="nav">
        <Button variant="ghost" href="/match" onclick={(e) => handleNavClick(e, 'match')}
          >対戦へ</Button
        >
        <Button variant="ghost" href="/" onclick={(e) => handleNavClick(e, 'home')}>ホームへ</Button
        >
      </nav>
    </section>
  </div>
</div>

<style>
  .builder {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 48px 70px;
    background: var(--bg-radial-top);
    font-family: var(--font-body);
  }

  .top {
    flex: none;
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }

  .top h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 48px;
    font-weight: 800;
    color: var(--text-heading);
  }

  .pills {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
  }

  .pill {
    font-family: var(--font-body);
    font-size: 24px;
    padding: 8px 26px;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--border-dim);
    background: none;
    color: var(--text-body);
    cursor: pointer;
    transition:
      background 0.12s ease-out,
      border-color 0.12s ease-out,
      color 0.12s ease-out,
      box-shadow 0.12s ease-out;
  }

  .pill.effect {
    border-color: var(--gold-glow-50);
    color: var(--gold-bright);
  }

  .pill.quick {
    border-color: var(--status-haste-text);
    color: var(--status-haste-text);
  }

  .pill.active {
    border-color: transparent;
    background: var(--gold);
    color: var(--parchment-text);
    font-weight: 700;
  }

  .pill:hover:not(.active),
  .pill:focus-visible:not(.active) {
    box-shadow: 0 0 14px rgba(122, 111, 196, 0.25);
    outline: none;
  }

  .rule {
    margin: 0 0 0 auto;
    font-size: 22px;
    color: var(--text-faint);
    white-space: nowrap;
  }

  .grid {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    justify-content: center;
    gap: 56px 40px;
    padding: 28px 8px 40px;
  }

  .pool-item {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 40px;
    width: 172px;
  }

  /* Card.svelte 自体は変更せず、ラッパーから内部の .card 要素を上書きして
     2/2 到達時の紫枠+発光を表現する(README「デッキ編集」仕様)。 */
  .pool-item.full :global(.card.front) {
    border: var(--card-border-w-selected) solid var(--purple-border);
    box-shadow: 0 0 22px rgba(122, 111, 196, 0.4);
  }

  .pc-buttons {
    display: flex;
    gap: 10px;
    width: 100%;
  }

  .pc-btn {
    flex: 1;
    height: 40px;
    border-radius: 8px;
    border: 1.5px solid var(--border-dim);
    background: none;
    color: var(--text-body);
    font-family: var(--font-mono);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    transition:
      border-color 0.12s ease-out,
      color 0.12s ease-out;
  }

  .pc-btn:hover:not(:disabled),
  .pc-btn:focus-visible:not(:disabled) {
    border-color: var(--purple-border);
    color: var(--text-heading);
    outline: none;
  }

  .pc-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .tray {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 26px;
    padding: 24px 32px;
  }

  .tray-status {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 14px;
  }

  .tray-count {
    font-family: var(--font-mono);
    font-size: 28px;
    font-weight: 700;
    color: var(--text-heading);
  }

  .tray-ok {
    font-size: 24px;
    font-weight: 700;
    color: var(--status-ok);
  }

  .tray-ng {
    font-size: 20px;
    color: var(--status-warning-text);
  }

  .tray-chips {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .chip {
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1;
    border: 1.5px solid var(--border-card);
    border-radius: 6px;
    padding: 6px 12px;
    background: var(--parchment-start);
    color: var(--parchment-text);
  }

  .chip.gold {
    border-color: var(--gold);
    background: var(--parchment-gold-start);
    color: var(--parchment-effect-text);
  }

  .tray-actions {
    flex: none;
    display: flex;
    gap: 16px;
  }

  .saved {
    flex: none;
    margin: 0;
    text-align: center;
    font-size: 22px;
    color: var(--status-ok);
  }

  .nav {
    flex: none;
    display: flex;
    justify-content: center;
    gap: 16px;
  }
</style>
