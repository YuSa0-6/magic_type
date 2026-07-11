<script lang="ts">
  import type {
    MatchSnapshot,
    MatchTimers,
    Card as CardModel,
    ActiveEffectView,
  } from '@magic/server/engine';
  import Card from '../../ui/Card.svelte';
  import HpBar from '../../ui/HpBar.svelte';
  import Panel from '../../ui/Panel.svelte';
  import StatusBadge from '../../ui/StatusBadge.svelte';
  import CountdownOverlay from '../../ui/CountdownOverlay.svelte';
  import { formatSeconds } from '../../lib/format';
  import { HAND_ROTATIONS } from '../../lib/card-format';

  // 対戦バトル画面: 2 陣営のスナップショットを表示するだけの薄い皮(ADR 0002)。
  // 業務ロジックは持たず、カードクリックは親へ通知するのみ。自陣のみ操作可能。
  // 状態は入力軸(snapshot)と時間軸(timers)に分かれる(ADR 0008)。
  interface Props {
    snapshot: MatchSnapshot;
    timers: MatchTimers;
    /** 現在時刻(呼び出し側の権威時計と同じ軸: vsボットは performance.now()、オンラインは
     * サーバーと合わせた Date.now())。activeEffects の expiresAtMs 判定にのみ使う表示専用の値。 */
    nowMs: number;
    imeWarning: boolean;
    onSelectCard: (handIndex: number) => void;
    /** 相手の表示名(オフラインは「相手(ボット)」、オンラインは「相手」)。 */
    opponentLabel?: string;
    /** 接続状況などのバナー文言(オンラインの切断/再接続表示用)。未指定なら出さない。 */
    statusBanner?: string | null;
    /** 効果音のミュート状態(表示専用)。状態は親が sound モジュール経由で保持する。 */
    muted: boolean;
    /** ミュート切替を親へ通知する(状態の書き込みは親で行う, ADR 0002)。 */
    onToggleMute: () => void;
    /** カウントダウン中の表示値。null なら通常表示(盤面フル彩度・オーバーレイなし)。
     * オンライン対戦(Room.svelte)は渡さないので既定 null=カウントダウンなしになる。 */
    countdownValue?: number | 'go' | null;
  }

  const {
    snapshot,
    timers,
    nowMs,
    imeWarning,
    onSelectCard,
    opponentLabel = '相手(ボット)',
    statusBanner = null,
    muted,
    onToggleMute,
    countdownValue = null,
  }: Props = $props();

  // ミュートトグルのクリック。トグル後はボタンを blur して以後の打鍵を妨げない(ADR 0012)。
  function handleMuteClick(e: MouseEvent): void {
    onToggleMute();
    (e.currentTarget as HTMLButtonElement).blur();
  }

  const self = $derived(snapshot.self);
  const opponent = $derived(snapshot.opponent);
  const selectedCard = $derived(self.selectedIndex === null ? null : self.hand[self.selectedIndex]);

  // 持続効果(haste/slow)を日本語ラベルに整形する(表示専用)。StatusBadge の variant にも kind をそのまま渡す。
  function effectLabel(kind: 'haste' | 'slow'): string {
    return kind === 'haste' ? '加速' : '鈍化';
  }

  // 相手伏せ札の逆さ扇(180±数度)。呼び出し側で角度を決めて Card に渡す。
  const OPP_HAND_ROTATIONS = [176, 179, 181, 184];

  // PlayerSide は期限切れの時限効果(haste/slow)を timedCdEffects から自発的に除去しない
  // (エンジン側 cdDeltaAt が atMs と expiresAtMs を比較して都度フィルタする契約, player-side.ts)。
  // よって activeEffects をそのまま表示・計算に使うと、効果の窓が過ぎた後もバッジやCDゲージに
  // 永遠に影響し続ける。ここで nowMs との比較により失効分を落としてから使う。
  function liveEffects(effects: readonly ActiveEffectView[]): readonly ActiveEffectView[] {
    return effects.filter((eff) => nowMs <= eff.expiresAtMs);
  }

  // CD ゲージは「回復の進捗」を 0→1 で表す。selfCooldownRemainingMs を実効 CD 時間で割って反転する。
  // 実効 CD 時間はエンジン内部にしか無い(MatchTimers/ActiveEffectView は公開しない)ため、
  // 現在アクティブな haste/slow から近似する(エンジンの cdDeltaAt と同じ考え方)。CD 開始後に
  // 効果が新たに切れる/入れ替わると近似はズレるが、card.cooldownMs 固定(旧実装)は haste/slow 中
  // 必ず不正確(進捗が負になりゲージが消える等)だったのに対し、これは実態に近い次善策。
  function estimatedCooldownTotalMs(card: CardModel): number {
    let delta = 0;
    for (const eff of liveEffects(self.activeEffects)) {
      delta += eff.kind === 'haste' ? -eff.ms : eff.ms;
    }
    return Math.max(1, card.cooldownMs + delta);
  }

  function cooldownRecovery(card: CardModel): number | undefined {
    if (timers.selfCooldownRemainingMs <= 0) return undefined;
    return 1 - timers.selfCooldownRemainingMs / estimatedCooldownTotalMs(card);
  }

  // 被弾シェイク(README「自分側が一瞬シェイク」)。自陣 HP の減少を検知して seq をインクリメント。
  // rAF は使わない(ADR 0008)。prevSelfHp は描画に使わない履歴。このページ限定の演出なので
  // 共通部品化せずトップレベルに閉じる。footer を {#key} で貼り直すと中の HpBar が再マウントされ
  // 内部のフラッシュ検知履歴が消えるため、footer 自体は再マウントしない。代わりに同一 seq が
  // 連続する短い間隔での再被弾でも必ずアニメーションが再生されるよう、奇数/偶数 seq で名前違いの
  // 同一 keyframes を交互に割り当てる(同じ animation 値の再代入はブラウザが再生しないため)。
  let prevSelfHp: number | null = null;
  let shakeSeq = $state(0);
  $effect(() => {
    const cur = self.hp;
    if (prevSelfHp !== null && cur < prevSelfHp) shakeSeq += 1;
    prevSelfHp = cur;
  });
  const shakeStyle = $derived(
    shakeSeq === 0 ? '' : `animation: self-shake-${shakeSeq % 2 === 0 ? 'b' : 'a'} 0.4s ease-out;`
  );
</script>

{#snippet statusBadges(effects: readonly ActiveEffectView[], shield: number)}
  {#each liveEffects(effects) as eff (eff.kind)}
    <StatusBadge variant={eff.kind} label={effectLabel(eff.kind)} />
  {/each}
  {#if shield > 0}
    <StatusBadge variant="shield" label={`盾 ${shield}`} />
  {/if}
{/snippet}

<div class="stage-viewport">
  <div class="stage">
    <section class="battle" class:dimming={countdownValue != null}>
      <!-- 接続状況バナー(オンラインの切断/再接続表示用)。 -->
      {#if statusBanner}
        <div class="banner">
          <StatusBadge variant="warning" role="status" label={statusBanner} />
        </div>
      {/if}

      <!-- 上段: 相手情報(左)・相手の伏せ札(中央)・残り時間/ミュート(右) -->
      <header class="top">
        <div class="side-info opponent">
          <div class="info-head">
            <span class="who">{opponentLabel}</span>
            {@render statusBadges(opponent.activeEffects, opponent.shield)}
            <span class="hp-num">{opponent.hp}/{opponent.maxHp}</span>
          </div>
          <HpBar hp={opponent.hp} maxHp={opponent.maxHp} side="opponent" shield={opponent.shield} />
        </div>

        <div class="opp-field">
          <div class="opp-hand">
            {#each opponent.hand as _card, i (i)}
              <Card
                face="back"
                width={130}
                interactive={false}
                rotateDeg={OPP_HAND_ROTATIONS[i] ?? 180}
                casting={opponent.selectedIndex === i}
              />
            {/each}
          </div>
          <div class="opp-cast">
            {#if opponent.selectedIndex !== null}
              詠唱中… 進捗 {opponent.typedRomaji.length} 文字
              <span class="opp-cd"
                >(クールダウン {formatSeconds(timers.opponentCooldownRemainingMs)}秒)</span
              >
            {:else}
              構え中…
            {/if}
          </div>
        </div>

        <div class="clock">
          <div class="clock-time">
            <span class="clock-num">⏳ {formatSeconds(timers.remainingMs)}</span>
            <span class="clock-unit">秒</span>
          </div>
          <button
            type="button"
            class="mute"
            aria-label={muted ? '効果音をオンにする' : '効果音をオフにする'}
            aria-pressed={muted}
            onclick={handleMuteClick}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </header>

      <!-- 中段: 詠唱枠(選択中カードのお題と詠唱状況)。IME 警告もここに出す。 -->
      <div class="cast">
        {#if imeWarning}
          <div class="ime">
            <StatusBadge
              variant="warning"
              label="日本語入力(IME)がオンのようです。半角英数で入力してください"
            />
          </div>
        {/if}
        <Panel variant="parchment">
          <div class="cast-body">
            {#if selectedCard}
              <div class="cast-title">{selectedCard.displayText}</div>
              <div class="cast-kana">{selectedCard.reading}</div>
              <div class="cast-romaji">
                <span class="typed">{self.typedRomaji}</span><span class="remaining"
                  >{self.remainingGuide}</span
                >
              </div>
            {:else}
              <div class="cast-empty">カードを選択してください(左から 1〜4 キー / クリック)</div>
            {/if}
          </div>
        </Panel>
      </div>

      <!-- 下段: 自陣情報(左)・手札4枚(中央)・山札/捨て札(右)。被弾でシェイクする。 -->
      <footer class="bottom" style={shakeStyle}>
        <div class="side-info self">
          <div class="info-head">
            <span class="who">自分</span>
            {@render statusBadges(self.activeEffects, self.shield)}
            <span class="hp-num">{self.hp}/{self.maxHp}</span>
          </div>
          <HpBar hp={self.hp} maxHp={self.maxHp} side="self" shield={self.shield} />
          <div class="self-meta">
            <span>誤入力 {self.castMistypes}</span>
            <span>CD {formatSeconds(timers.selfCooldownRemainingMs)}秒</span>
          </div>
        </div>

        <div class="hand">
          {#each self.hand as card, i (i)}
            <Card
              face="front"
              {card}
              width={150}
              interactive
              rotateDeg={HAND_ROTATIONS[i] ?? 0}
              selected={self.selectedIndex === i}
              cooldownProgress={cooldownRecovery(card)}
              onSelect={() => onSelectCard(i)}
            />
          {/each}
        </div>

        <div class="piles">
          <span>山札 {self.drawPileCount}</span>
          <span>捨て札 {self.discardPileCount}</span>
        </div>
      </footer>
    </section>

    <!-- 減彩される .battle の外(兄弟)に置く。opacity は子孫も合成するため、オーバーレイ
         自身が薄くならないよう .stage 直下の兄弟にする。 -->
    {#if countdownValue != null}
      <CountdownOverlay value={countdownValue} />
    {/if}
  </div>
</div>

<style>
  /* オーバーレイ(position:absolute; inset:0)の位置基準。
     背景も敷くのは、減彩(.battle opacity .22)時に白い body が透けて盤面が白く沈むのを防ぐため
     (デザイン 6c: 背景は暗いまま、内容だけ 22% に沈む)。通常時は不透明な .battle が覆う。 */
  .stage {
    position: relative;
    background: var(--bg-radial-battle);
  }

  .battle {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 40px 72px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-radial-battle);
    font-family: var(--font-body);
    /* 開始で色が戻る滑らかな遷移(README「開始で盤面の彩度が戻る」)。 */
    transition: opacity 0.3s ease-out;
  }

  /* カウントダウン中は盤面を減彩表示(README: opacity .22)。 */
  .battle.dimming {
    opacity: 0.22;
  }

  /* 接続状況バナー: 盤面上部中央にオーバーレイ(3 段レイアウトを崩さない)。 */
  .banner {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2;
  }

  /* 上段・下段は同じ [460px][flex:1][280px] の対面構成(上は上詰め・下は下詰め)。 */
  .top,
  .bottom {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 40px;
  }

  .top {
    align-items: flex-start;
  }

  .bottom {
    align-items: flex-end;
  }

  .side-info {
    width: 460px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .info-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 14px;
  }

  .who {
    font-family: var(--font-serif);
    font-size: 34px;
    font-weight: 700;
    color: var(--text-heading);
  }

  .hp-num {
    font-family: var(--font-mono);
    font-size: 26px;
    color: var(--text-body);
  }

  .self-meta {
    display: flex;
    gap: 20px;
    font-size: 22px;
    color: var(--text-faint);
  }

  /* 相手の伏せ札(逆さ扇)と詠唱進捗テキスト。 */
  .opp-field {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding-top: 8px;
  }

  .opp-hand {
    display: flex;
    justify-content: center;
    align-items: flex-start;
    gap: 26px;
  }

  .opp-cast {
    font-size: 22px;
    color: var(--text-faint);
    text-align: center;
  }

  .opp-cd {
    color: var(--text-faintest);
  }

  /* 残り時間 + ミュート(右上)。 */
  .clock {
    width: 280px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 14px;
  }

  .clock-time {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .clock-num {
    font-family: var(--font-mono);
    font-size: 44px;
    font-weight: 700;
    color: var(--text-heading);
    letter-spacing: 0.02em;
  }

  .clock-unit {
    font-size: 24px;
    color: var(--text-faint);
  }

  .mute {
    width: 52px;
    height: 52px;
    border: 2px solid var(--gold);
    border-radius: 12px;
    background: rgba(201, 163, 90, 0.06);
    color: var(--text-heading);
    cursor: pointer;
    font-size: 24px;
    line-height: 1;
    transition: box-shadow 0.12s ease-out;
  }

  .mute:hover,
  .mute:focus-visible {
    box-shadow: 0 0 18px var(--gold-glow-25);
    outline: none;
  }

  /* 中段: 詠唱枠。 */
  .cast {
    width: 980px;
  }

  .ime {
    display: flex;
    justify-content: center;
    margin-bottom: 12px;
  }

  .cast-body {
    padding: 30px 40px;
    text-align: center;
    min-height: 150px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .cast-title {
    font-family: var(--font-serif);
    font-size: 40px;
    font-weight: 700;
    color: var(--parchment-text);
  }

  .cast-kana {
    font-size: 24px;
    color: var(--parchment-text-sub);
  }

  .cast-romaji {
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 44px;
    letter-spacing: 0.04em;
  }

  .cast-romaji .typed {
    color: var(--romaji-typed);
    font-weight: 700;
  }

  .cast-romaji .remaining {
    color: var(--romaji-remaining);
  }

  .cast-empty {
    font-size: 32px;
    color: var(--parchment-text-sub);
  }

  /* 下段: 手札(中央)と山札/捨て札(右)。 */
  .hand {
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: flex-end;
    gap: 44px;
    padding-bottom: 16px;
  }

  .piles {
    width: 280px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    font-size: 24px;
    color: var(--text-faint);
  }

  /* 被弾シェイク: 自陣ブロック(下段)を一瞬だけ横に微振動させる(rAF 不使用, ADR 0008)。
     a/b は内容同一の keyframes を2つ用意したもの。同じ animation 値の再代入はブラウザが
     再生しないため、連続被弾でも必ず再生されるよう script 側で交互に切り替える。 */
  @keyframes self-shake-a {
    0%,
    100% {
      transform: translateX(0);
    }
    20% {
      transform: translateX(-7px);
    }
    40% {
      transform: translateX(6px);
    }
    60% {
      transform: translateX(-4px);
    }
    80% {
      transform: translateX(2px);
    }
  }

  @keyframes self-shake-b {
    0%,
    100% {
      transform: translateX(0);
    }
    20% {
      transform: translateX(-7px);
    }
    40% {
      transform: translateX(6px);
    }
    60% {
      transform: translateX(-4px);
    }
    80% {
      transform: translateX(2px);
    }
  }
</style>
