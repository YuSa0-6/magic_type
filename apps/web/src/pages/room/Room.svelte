<script lang="ts">
  import type { MatchSnapshot } from '@magic/server/engine';
  import { handleNavClick } from '../../lib/router.svelte';
  import { loadDeckIds, defaultDeckIds, resolveDeck } from '../../lib/deck-storage';
  import { MatchTransport } from '../../lib/match-transport.svelte';
  import { SelfPredictor, type SelfTypingPrediction } from '../../lib/match-prediction';
  import * as sound from '../../lib/sound.svelte';
  import MatchBattleScreen from '../match/MatchBattleScreen.svelte';
  import MatchResultScreen from '../match/MatchResultScreen.svelte';
  import Panel from '../../ui/Panel.svelte';
  import Button from '../../ui/Button.svelte';
  import StatusBadge from '../../ui/StatusBadge.svelte';

  // オンライン対戦の親(B3 web 配線, ADR 0011 #1/#2/#5/#6/#8/#9)。
  //
  // ロビー(部屋を作る / コードで参加)→ 相手待ち → 対戦(サーバー権威 + 自陣予測)→ 結果。
  // - 自陣の打鍵は即時ローカル予測(SelfPredictor)で typedRomaji/ガイド/詠唱進捗を出す
  //   (RTT 待ちゼロ)。HP・効果・CD・相手陣・勝敗はサーバー push の権威 state を表示する。
  // - 自陣の打鍵は 40ms バッチで input としてサーバーへ送る(MatchTransport, ADR 0011 #2)。
  // - 切断は自動再接続(サーバーが権威時計を凍結して猶予待ち, ADR 0011 #8/#11)。
  //
  // オフライン(対ボット, /match)・ソロ/タイムアタックは不変。ここは独立した導線。

  // トランスポートは $state にしない(内部の runes フィールドを直接読む)。
  // svelte-ignore non_reactive_update
  let transport = new MatchTransport();

  // 自陣予測エンジン(matchStart / matchResumed 後に生成)。$state 不要(snapshot を pull する)。
  // svelte-ignore non_reactive_update
  let predictor: SelfPredictor | null = null;

  // 参加用に入力するルームコード。
  let joinCode = $state('');
  // 自陣予測の打鍵フィードバック(時間 tick / 打鍵で更新)。
  let prediction = $state.raw<SelfTypingPrediction | null>(null);
  // IME(日本語入力)警告フラグ(Match.svelte と同じ扱い)。
  let imeWarning = $state(false);
  // ロビー操作中フラグ(二重押し抑止)。
  let busy = $state(false);
  // 再戦カウントダウン(#17)。決着中だけ 10→0 へ表示上カウントする(強制遷移はしない)。
  let rematchCountdown = $state(10);
  // ルームコードのコピーボタンの一時フィードバック表示(ロビー②待機画面)。
  let codeCopied = $state(false);
  let codeCopiedTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // 効果音のミュート状態(ADR 0002: 状態は親が sound モジュール経由で保持し props で渡す)。
  let muted = $state(sound.isMuted());

  // 盤面結果音(被弾/防御=自陣 / 命中=相手)検出用の前値トラッカー(ADR 0012 の盤面結果節)。
  // 非リアクティブな plain let。差分は transport.authState(HP/シールドの唯一の権威源)に対して
  // 取る(下の盤面結果 $effect)。null は未観測の番兵で、最初の観測ではベースライン設定のみ。
  // initPredictor(matchStart/matchResumed)で null に戻す(再接続後は最初の権威 state が基準)。
  let prevSelfHp: number | null = null;
  let prevSelfShield: number | null = null;
  let prevOppHp: number | null = null;

  // ミュートトグル。状態は sound モジュールが正(localStorage 永続)。
  function handleToggleMute(): void {
    sound.toggleMute();
    muted = sound.isMuted();
  }

  // 自分のデッキ(ID 配列 + 解決済み Card)。提出と予測初期化に使う。
  function selfDeckIds(): string[] {
    return loadDeckIds() ?? defaultDeckIds();
  }

  // 部屋を作る → コード発行 → そのコードで接続(作成側として着席)。
  async function createRoom(): Promise<void> {
    if (busy) return;
    // ロビーのボタン操作(ユーザージェスチャ)で音システムを起動(ADR 0012)。
    // 対戦開始(matchStart)はサーバー駆動でジェスチャを伴わないため、ここで unlock する。
    sound.resume();
    busy = true;
    try {
      const code = await transport.createRoom();
      transport.connect(code, selfDeckIds());
    } catch (e) {
      transport.errorMessage = e instanceof Error ? e.message : 'ルーム作成に失敗しました';
      transport.phase = 'error';
    } finally {
      busy = false;
    }
  }

  // コードで参加 → 接続(参加側として着席)。
  function joinRoom(): void {
    const code = joinCode.trim();
    if (busy || code.length === 0) return;
    // ロビーのボタン操作(ユーザージェスチャ)で音システムを起動(ADR 0012)。
    sound.resume();
    transport.connect(code, selfDeckIds());
  }

  // ルームコードをクリップボードへコピーする(ロビー②待機画面のコピーボタン)。
  // 失敗(非対応環境・許可拒否)は静かに無視し、フィードバック表示のみ出さない。
  async function handleCopyCode(): Promise<void> {
    if (!transport.code) return;
    try {
      await navigator.clipboard.writeText(transport.code);
    } catch {
      return;
    }
    codeCopied = true;
    if (codeCopiedTimeoutId !== null) clearTimeout(codeCopiedTimeoutId);
    codeCopiedTimeoutId = setTimeout(() => {
      codeCopied = false;
    }, 1500);
  }

  // matchStart / matchResumed を受けたら予測エンジンを(再)初期化する。
  // 再接続時も同じ seed + role + 自デッキで作り直し、権威 state で表示を回復させる(予測はそこから先行)。
  //
  // role を渡すのが要(B3 監査 should-fix): 各陣営の山札 RNG は side index 派生ストリーム
  // (ADR 0011 #13)で、権威は role 順に side を割り当てる。self を実 role index に置かないと
  // 初期手札が権威と恒常的に食い違い reconcile が常時フォールバックして参加側(role1)の打鍵
  // 予測が効かなくなる。role は joined で確定済み(matchStart より前)。
  function initPredictor(): void {
    const start = transport.start;
    const role = transport.role;
    if (start === null || role === null) return;
    predictor = new SelfPredictor(start.seed, role, start.selfId, resolveDeck(selfDeckIds()));
    predictor.start(now());
    prediction = predictor.snapshot();
    // 盤面結果音の前値をベースラインし直す(ADR 0012)。再接続(matchResumed)時は次の権威
    // state の途中 HP を初回観測としてベースラインするため、切断中の被弾を音で再生しない。
    prevSelfHp = null;
    prevSelfShield = null;
    prevOppHp = null;
  }

  // transport の購読: matchStart/matchResumed で予測初期化。state は権威表示に使う(別途 $derived)。
  transport.onMessage = (msg) => {
    if (msg.type === 'matchStart' || msg.type === 'matchResumed') {
      initPredictor();
      imeWarning = false;
    }
  };

  // サーバーと同じウォール時計(Date.now())。予測と送信 atMs を同一軸に揃える(ADR 0011 #2)。
  function now(): number {
    return Date.now();
  }

  // 時間 tick(約 100ms, ADR 0008)。自陣予測の表示更新のみ。
  // 権威状態(HP 等)は transport.authState が WS push で随時更新されるためここでは触らない。
  $effect(() => {
    if (transport.phase !== 'matched' || predictor === null) {
      return;
    }
    const id = setInterval(() => {
      if (predictor === null) return;
      prediction = predictor.snapshot();
    }, 100);
    return () => clearInterval(id);
  });

  // 画面離脱時に WS を閉じる。
  $effect(() => {
    return () => transport.leave();
  });

  // 画面離脱時にコピーボタンの一時フィードバック用タイマーが生きていれば止める。
  $effect(() => {
    return () => {
      if (codeCopiedTimeoutId !== null) clearTimeout(codeCopiedTimeoutId);
    };
  });

  // 再戦カウントダウン(#17)。transport.phase === 'ended' の間だけ 1 秒ごとに減らし 0 でクランプ。
  // これは表示上の心理的な目安に過ぎず、0 になっても強制キャンセル・ホームへの自動遷移はしない。
  $effect(() => {
    if (transport.phase !== 'ended') {
      rematchCountdown = 10;
      return;
    }
    rematchCountdown = 10;
    const id = setInterval(() => {
      rematchCountdown = Math.max(0, rematchCountdown - 1);
    }, 1000);
    return () => clearInterval(id);
  });

  // 表示用スナップショット: 自陣の打鍵フィードバックは予測、HP/効果/相手/勝敗は権威。
  // 予測がまだ無ければ権威 state をそのまま使う(再接続直後の回復など)。
  //
  // reconcile(権威優先, ADR 0011 #1): 予測の手札と権威の手札(カード id 列)が食い違うときは
  // 予測が陳腐化している(例: 相手の discard で権威側の手札が変わった/タイミング差)。フルの
  // ロールバック和解は v1 では持たない(将来最適化, ADR 0011 追記)ため、食い違う間は自陣の
  // 表示も権威 state に倒して整合させる(打鍵視覚の先行は手札が一致している間だけ効かせる)。
  const displaySnapshot = $derived.by<MatchSnapshot | null>(() => {
    const auth = transport.authState;
    if (auth === null) return null;
    const pred = prediction;
    if (pred === null || !sameHand(pred.hand, auth.self.hand)) {
      return { self: auth.self, opponent: auth.opponent, outcome: auth.outcome };
    }
    // 自陣: 打鍵視覚(hand/選択/typed/ガイド/誤入力)は予測、HP/シールド/効果/山札は権威。
    return {
      self: {
        ...auth.self,
        hand: pred.hand,
        selectedIndex: pred.selectedIndex,
        typedRomaji: pred.typedRomaji,
        remainingGuide: pred.remainingGuide,
        castMistypes: pred.castMistypes,
      },
      opponent: auth.opponent,
      outcome: auth.outcome,
    };
  });

  // 予測と権威の手札がカード id 列として一致するか(reconcile 判定)。
  function sameHand(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
    }
    return true;
  }

  // 盤面結果音(被弾/防御=自陣 / 命中=相手)を権威スナップショット差分で鳴らす(ADR 0012)。
  // 依存は displaySnapshot ではなく transport.authState(=HP/シールドの唯一の権威源)に張る。
  // HP/シールドは権威でしか変わらない(ADR 0011 #9)ので、予測(打鍵)では authState が変わらず
  // この effect は再走しない=予測二重発火が構造的に無い。
  //
  // 再接続(matchResumed)時の誤発火防止(B3 監査 blocker): matchResumed と直後の現況 state は
  // サーバーで別フレーム送信(match-room.ts)=クライアントでは別 message イベント。matchResumed
  // ハンドラの initPredictor() で prev3値を null に戻すが、その時点で authState は切断前の古い HP
  // のまま残っている(transport は authState を一度もクリアしない)。もし displaySnapshot に依存
  // していると、prediction 再代入で中間 flush が走り「切断前の古い HP」をベースラインに焼き付け、
  // 続く現況 state(切断中に削られた低い HP)との差分で偽の被弾/命中音が鳴ってしまう。authState
  // に依存すれば prediction 再代入では再走せず、matchResumed 後の最初の権威 state(=再開後の
  // 現在 HP)が初回観測=ベースラインとなり、切断中に進んだ差分は鳴らない。
  // 前値が !==null(=ベースライン済み)の時のみ鳴らし、その後に前値を現値へ更新する。
  $effect(() => {
    const auth = transport.authState;
    if (auth === null) return;
    if (prevSelfHp !== null && prevSelfShield !== null && prevOppHp !== null) {
      sound.playSelfDamage(prevSelfHp, auth.self.hp, prevSelfShield, auth.self.shield);
      sound.playEnemyHit(prevOppHp, auth.opponent.hp);
    }
    prevSelfHp = auth.self.hp;
    prevSelfShield = auth.self.shield;
    prevOppHp = auth.opponent.hp;
  });

  // 接続状況バナー(切断猶予 / 再接続 / 相手切断, ADR 0011 #8/#11)。
  const statusBanner = $derived.by<string | null>(() => {
    if (transport.reconnecting) return '接続が切れました。再接続しています…';
    if (transport.opponentPaused) return '相手が切断しました。再接続を待っています…';
    return null;
  });

  // ロビーの待機メッセージ。
  const waitingMessage = $derived.by(() => {
    if (transport.role === null) return '接続中…';
    if (!transport.opponentPresent) return '相手の参加を待っています…';
    return '対戦開始の準備中…';
  });

  // 再戦に同意する(#17)。両者が同意すると新しい matchStart が届き、predictor が作り直される。
  function handleRematch(): void {
    transport.requestRematch();
  }

  // カードクリック(自陣のみ)。予測へ反映し、サーバーへも送る。
  function handleSelectCard(handIndex: number): void {
    if (predictor === null) return;
    const t = now();
    // 選択が実際に変わった時だけ選択音を鳴らす(同カード再選択は no-op, ADR 0012)。
    const before = predictor.snapshot().selectedIndex;
    predictor.select(handIndex, t);
    transport.enqueueSelect(handIndex, t);
    prediction = predictor.snapshot();
    if (prediction.selectedIndex !== before) {
      sound.playSelect();
    }
  }

  // window keydown を一元処理する(対戦中の自陣入力のみ)。Match.svelte と同じ規約。
  function handleKeydown(e: KeyboardEvent): void {
    if (transport.phase === 'ended') {
      if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        handleRematch();
      }
      return;
    }
    if (transport.phase !== 'matched' || predictor === null) {
      return;
    }
    if (e.isComposing || e.keyCode === 229) {
      imeWarning = true;
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
      return;
    }
    const t = now();
    if (e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      const idx = Number(e.key) - 1;
      // 選択が実際に変わった時だけ選択音を鳴らす(ADR 0012)。
      const before = predictor.snapshot().selectedIndex;
      predictor.select(idx, t);
      transport.enqueueSelect(idx, t);
      prediction = predictor.snapshot();
      if (prediction.selectedIndex !== before) {
        sound.playSelect();
      }
      return;
    }
    if (e.key === '-' || (e.key.length === 1 && e.key >= 'a' && e.key <= 'z')) {
      e.preventDefault();
      const result = predictor.press(e.key, t);
      sound.playForResult(result);
      transport.enqueuePress(e.key, t);
      prediction = predictor.snapshot();
      imeWarning = false;
    }
  }

  // 結果画面の outcome(視点は自陣)。matchEnd の outcome を MatchOutcome 形へ写す。
  const finalOutcome = $derived.by(() => {
    const ended = transport.ended;
    if (ended === null) return null;
    const endReason = ended.endReason as 'ko' | 'timeup' | 'forfeit';
    if (ended.outcome === 'draw') return { kind: 'draw' as const, endReason };
    if (ended.outcome === 'win') return { kind: 'win' as const, endReason };
    if (ended.outcome === 'forfeit') return { kind: 'forfeit' as const, endReason };
    return { kind: 'lose' as const, endReason };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if transport.phase === 'idle'}
  <!-- ロビー①: 部屋を作る / コードで参加 -->
  <div class="stage-viewport">
    <div class="stage">
      <section class="room">
        <h1>オンライン対戦</h1>
        <div class="gate-panels">
          <div class="gate-slot">
            <Panel variant="gold">
              <div class="gate">
                <div class="gate-icon" aria-hidden="true">門</div>
                <h2>部屋を作る</h2>
                <p>部屋を作成してコードを発行し、相手の参加を待ちます。</p>
                <Button variant="primary" onclick={createRoom} disabled={busy}>部屋を作る</Button>
              </div>
            </Panel>
          </div>
          <div class="gate-slot">
            <Panel variant="gold">
              <div class="gate">
                <div class="gate-icon" aria-hidden="true">鍵</div>
                <h2>コードで参加</h2>
                <p>相手から共有されたルームコードを入力して参加します。</p>
                <input
                  type="text"
                  class="code-input"
                  placeholder="______"
                  bind:value={joinCode}
                  aria-label="ルームコード"
                />
                <Button variant="primary" onclick={joinRoom} disabled={busy}>参加する</Button>
              </div>
            </Panel>
          </div>
        </div>
        <nav class="nav">
          <Button variant="ghost" href="/match" onclick={(e) => handleNavClick(e, 'match')}
            >vsボットで練習</Button
          >
          <Button variant="ghost" href="/deck" onclick={(e) => handleNavClick(e, 'deck')}
            >デッキ編集</Button
          >
          <Button variant="ghost" href="/" onclick={(e) => handleNavClick(e, 'home')}
            >ホームへ戻る</Button
          >
        </nav>
      </section>
    </div>
  </div>
{:else if transport.phase === 'connecting' || transport.phase === 'waiting'}
  <!-- ロビー②: 接続 / 相手待ち -->
  <div class="stage-viewport">
    <div class="stage">
      <section class="room">
        <h1>オンライン対戦</h1>
        {#if transport.code}
          <div class="code-slot">
            <Panel variant="gold">
              <div class="code-content">
                <p class="code-caption">ルームコード — 相手に共有</p>
                <div class="code-value">{transport.code}</div>
                <button type="button" class="copy-btn" onclick={handleCopyCode}>
                  {codeCopied ? 'コピーしました' : 'コピー 📋'}
                </button>
              </div>
            </Panel>
          </div>
        {/if}
        <div class="ready-cards">
          <div class="ready-card">
            <div class="ready-icon" aria-hidden="true"></div>
            <div class="ready-name">あなた</div>
            <div class="ready-status">✓ 準備完了</div>
          </div>
          <div class="ready-card" class:pending={!transport.opponentPresent}>
            <div class="ready-icon" aria-hidden="true"></div>
            <div class="ready-name">相手</div>
            {#if transport.opponentPresent}
              <div class="ready-status">✓ 準備完了</div>
            {:else}
              <div class="ready-status pending">参加待ち… ⏳</div>
            {/if}
          </div>
        </div>
        <p class="waiting-message">{waitingMessage}</p>
        <nav class="nav">
          <Button variant="ghost" href="/" onclick={(e) => handleNavClick(e, 'home')}
            >キャンセルして戻る</Button
          >
        </nav>
      </section>
    </div>
  </div>
{:else if transport.phase === 'error'}
  <!-- 復帰不能エラー -->
  <div class="stage-viewport">
    <div class="stage">
      <section class="room">
        <h1>オンライン対戦</h1>
        <StatusBadge variant="warning" label={transport.errorMessage ?? 'エラーが発生しました'} />
        <nav class="nav">
          <Button variant="ghost" href="/" onclick={(e) => handleNavClick(e, 'home')}
            >ホームへ戻る</Button
          >
        </nav>
      </section>
    </div>
  </div>
{:else if transport.phase === 'ended' && finalOutcome && displaySnapshot}
  <!-- 結果 -->
  <MatchResultScreen
    outcome={finalOutcome}
    snapshot={displaySnapshot}
    opponentLabel="相手"
    promptText="対戦が終了しました"
    rematch={{
      countdownSeconds: rematchCountdown,
      selfRequested: transport.rematchSelfRequested,
      opponentRequested: transport.rematchOpponentRequested,
      onRematch: handleRematch,
    }}
  />
{:else if displaySnapshot && transport.authState}
  <!-- 対戦中(matched / ended で displaySnapshot がまだ結果未確定の遷移含む) -->
  <MatchBattleScreen
    snapshot={displaySnapshot}
    timers={transport.authState.timers}
    nowMs={now()}
    {imeWarning}
    onSelectCard={handleSelectCard}
    opponentLabel="相手"
    {statusBanner}
    {muted}
    onToggleMute={handleToggleMute}
  />
{:else}
  <!-- matchStart 直後で最初の state がまだ届いていない -->
  <div class="stage-viewport">
    <div class="stage">
      <section class="room">
        <h1>オンライン対戦</h1>
        <p class="transition-text">対戦開始…</p>
      </section>
    </div>
  </div>
{/if}

<style>
  .room {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 48px;
    padding: 80px;
    background: var(--bg-radial-top);
    font-family: var(--font-body);
    text-align: center;
  }

  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 64px;
    font-weight: 800;
    color: var(--text-heading);
  }

  .nav {
    display: flex;
    justify-content: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  /* ロビー①: 門型パネル2枚。 */
  .gate-panels {
    display: flex;
    gap: 48px;
  }

  .gate-slot {
    width: 480px;
  }

  .gate {
    box-sizing: border-box;
    padding: 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
  }

  .gate-icon {
    width: 120px;
    height: 120px;
    flex: none;
    border-radius: 50% 50% 12px 12px;
    border: 2.5px solid var(--gold);
    background: repeating-linear-gradient(-45deg, #241d40 0 10px, #2a2249 10px 20px);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 18px;
    color: var(--gold);
  }

  .gate h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 38px;
    font-weight: 700;
    color: var(--text-heading);
  }

  .gate p {
    margin: 0;
    font-size: 24px;
    color: var(--text-body);
    min-height: 2.4em;
  }

  .code-input {
    box-sizing: border-box;
    width: 100%;
    padding: 18px;
    border: 2px dashed var(--border-dim);
    border-radius: 12px;
    background: transparent;
    font-family: var(--font-mono);
    font-size: 30px;
    letter-spacing: 0.3em;
    text-align: center;
    color: var(--text-heading);
  }

  .code-input::placeholder {
    color: var(--text-faintest);
  }

  .code-input:focus-visible {
    outline: none;
    border-color: var(--purple-border);
  }

  /* ロビー②: ルームコード表示(金パネル)。 */
  .code-slot {
    width: 640px;
  }

  .code-content {
    box-sizing: border-box;
    padding: 36px 60px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .code-caption {
    margin: 0;
    font-size: 24px;
    color: var(--text-body);
  }

  .code-value {
    font-family: var(--font-mono);
    font-size: 80px;
    font-weight: 700;
    letter-spacing: 0.25em;
    color: var(--gold-bright);
    text-shadow: 0 0 40px var(--gold-glow-50);
  }

  .copy-btn {
    font-family: var(--font-body);
    font-size: 22px;
    color: var(--link-purple);
    border: 1.5px solid var(--purple-border);
    border-radius: var(--radius-pill);
    padding: 8px 28px;
    background: transparent;
    cursor: pointer;
    transition: box-shadow 0.12s ease-out;
  }

  .copy-btn:hover,
  .copy-btn:focus-visible {
    box-shadow: 0 0 18px rgba(122, 111, 196, 0.35);
    outline: none;
  }

  /* ロビー②: あなた/相手の準備状況カード。 */
  .ready-cards {
    display: flex;
    gap: 36px;
  }

  .ready-card {
    box-sizing: border-box;
    width: 340px;
    padding: 32px;
    border-radius: var(--radius-panel);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    border: 2px solid var(--hp-self-end);
    background: rgba(111, 174, 131, 0.08);
  }

  .ready-card.pending {
    border: 2px dashed var(--border-dim);
    background: transparent;
  }

  .ready-icon {
    width: 90px;
    height: 90px;
    border-radius: 50%;
    border: 2.5px solid var(--hp-self-end);
    background: repeating-linear-gradient(-45deg, #241d40 0 9px, #2a2249 9px 18px);
  }

  .ready-card.pending .ready-icon {
    border: 2.5px dashed var(--border-dim);
    background: none;
  }

  .ready-name {
    font-family: var(--font-serif);
    font-size: 30px;
    font-weight: 700;
    color: var(--text-heading);
  }

  .ready-card.pending .ready-name {
    color: var(--text-faint);
  }

  .ready-status {
    font-size: 24px;
    color: var(--hp-self-end);
  }

  .ready-status.pending {
    color: var(--text-faintest);
  }

  .waiting-message {
    margin: 0;
    font-size: 24px;
    color: var(--text-body);
  }

  /* matchStart 直後の中間状態。 */
  .transition-text {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 40px;
    color: var(--gold-bright);
  }
</style>
