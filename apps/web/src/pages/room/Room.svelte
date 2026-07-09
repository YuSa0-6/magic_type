<script lang="ts">
  import type { MatchSnapshot } from '@magic/server/engine';
  import { handleNavClick } from '../../lib/router.svelte';
  import { loadDeckIds, defaultDeckIds, resolveDeck } from '../../lib/deck-storage';
  import { MatchTransport } from '../../lib/match-transport.svelte';
  import { SelfPredictor, type SelfTypingPrediction } from '../../lib/match-prediction';
  import * as sound from '../../lib/sound.svelte';
  import MatchBattleScreen from '../match/MatchBattleScreen.svelte';
  import MatchResultScreen from '../match/MatchResultScreen.svelte';

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

  // 時間 tick(約 100ms, ADR 0008)。自陣予測のクールダウン明け先行入力ドレイン + 表示更新。
  // 権威状態(HP 等)は transport.authState が WS push で随時更新されるためここでは触らない。
  $effect(() => {
    if (transport.phase !== 'matched' || predictor === null) {
      return;
    }
    const id = setInterval(() => {
      if (predictor === null) return;
      // 自陣予測のクールダウン明け先行入力をドレイン。受理した各打鍵に音を付ける(ADR 0012)。
      // これはローカル入力イベント由来で、サーバー権威 push(reconcile)とは無関係。
      const drained = predictor.drain(now());
      for (const r of drained) {
        sound.playForResult(r);
      }
      prediction = predictor.snapshot();
    }, 100);
    return () => clearInterval(id);
  });

  // 画面離脱時に WS を閉じる。
  $effect(() => {
    return () => transport.leave();
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
      // ADR 0012: 先に明示ドレインで保留中の先行入力を流して音を鳴らし、その後に当該キーを適用する
      // (予測 MatchEngine 内部のドレインで音が失われるのを防ぐ。順序は内部と同一)。自陣のみ。
      const drained = predictor.drain(t);
      for (const r of drained) {
        sound.playForResult(r);
      }
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
  <!-- ロビー: 部屋を作る / コードで参加 -->
  <section class="room">
    <h1>オンライン対戦</h1>
    <div class="panels">
      <div class="panel">
        <h2>部屋を作る</h2>
        <p>部屋を作成してコードを発行し、相手の参加を待ちます。</p>
        <button type="button" class="primary" onclick={createRoom} disabled={busy}
          >部屋を作る</button
        >
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
        <button type="button" class="primary" onclick={joinRoom} disabled={busy}>参加する</button>
      </div>
    </div>
    <nav class="nav">
      <a class="link" href="/match" onclick={(e) => handleNavClick(e, 'match')}>vsボットで練習</a>
      <a class="link" href="/deck" onclick={(e) => handleNavClick(e, 'deck')}>デッキ編集</a>
      <a class="link" href="/" onclick={(e) => handleNavClick(e, 'home')}>ホームへ戻る</a>
    </nav>
  </section>
{:else if transport.phase === 'connecting' || transport.phase === 'waiting'}
  <!-- 接続 / 相手待ち -->
  <section class="room">
    <h1>オンライン対戦</h1>
    {#if transport.code}
      <div class="code-box">
        ルームコード: <strong>{transport.code}</strong>
        <p class="hint">このコードを相手に共有してください。</p>
      </div>
    {/if}
    <div class="waiting">{waitingMessage}</div>
    <nav class="nav">
      <a class="link" href="/" onclick={(e) => handleNavClick(e, 'home')}>キャンセルして戻る</a>
    </nav>
  </section>
{:else if transport.phase === 'error'}
  <!-- 復帰不能エラー -->
  <section class="room">
    <h1>オンライン対戦</h1>
    <div class="error" role="alert">{transport.errorMessage ?? 'エラーが発生しました'}</div>
    <nav class="nav">
      <a class="link" href="/" onclick={(e) => handleNavClick(e, 'home')}>ホームへ戻る</a>
    </nav>
  </section>
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
    {imeWarning}
    onSelectCard={handleSelectCard}
    opponentLabel="相手"
    {statusBanner}
    {muted}
    onToggleMute={handleToggleMute}
  />
{:else}
  <!-- matchStart 直後で最初の state がまだ届いていない -->
  <section class="room">
    <h1>オンライン対戦</h1>
    <div class="waiting">対戦開始…</div>
  </section>
{/if}

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

  .panels {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 1.5rem;
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

  .primary:disabled {
    background: #9bbce0;
    cursor: default;
  }

  .code-box {
    margin: 1.5rem 0;
    font-size: 1.1rem;
    color: #333;
  }

  .code-box strong {
    font-size: 1.6rem;
    letter-spacing: 2px;
    color: #1565c0;
  }

  .code-box .hint {
    font-size: 0.85rem;
    color: #777;
    margin-top: 0.4rem;
  }

  .waiting {
    margin: 2rem 0;
    font-size: 1.1rem;
    color: #555;
  }

  .error {
    background: #fdecea;
    border: 1px solid #f5b5ae;
    color: #b3261e;
    border-radius: 6px;
    padding: 0.7rem 1rem;
    margin: 1.5rem 0;
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
