/**
 * プレイ中の効果音(ADR 0012)。
 *
 * 音源は Web Audio API でコード合成する(録音ファイルは使わない=バンドル 0KB)。
 * 音は「自分の操作」起点のみ鳴らす — 相手(対戦相手/ボット)の操作・サーバー権威の
 * スナップショット適用・予測 reconcile では一切鳴らさない。配線側(Game/Match/Room)が
 * 自陣のローカル入力イベント時にだけ本モジュールを呼ぶことでこれを担保する。
 *
 * 配置・規約: 状態(ミュート)を持つアプリ全体で 1 つの再生器なので、router.svelte.ts と
 * 同型の「モジュール singleton + $state + getter/名前付き関数 export」で公開する(ADR 0006)。
 * 音は web 層のみ。エンジン(@magic/server/engine)には音を入れない(ADR 0002 を維持)。
 * rAF は使わず、発火はイベント駆動(keydown / tick ドレイン)で行う(ADR 0008 整合)。
 *
 * 自動再生制約の回避: AudioContext はバトル開始のユーザージェスチャ(スペース/クリック)で
 * resume() を呼んで起動する。AudioContext は遅延生成し、再生前に resume をガードする。
 * window/AudioContext 非対応環境(SSR・テスト等)では全 API を no-op に縮退させる。
 *
 * ミュート永続化: deck-storage.ts と同じ localStorage パターン(try/catch で例外を握り、
 * 失敗時は既定へ倒す)。キーは 'magic:sound-muted'。既定は音オン(unmuted)。
 *
 * 将来の素材差し替え: 各音は playClick / playError / playSelectTone / playActivation の
 * 小さな合成関数に閉じている。録音素材へ差し替える場合はこれらの中身だけを変えればよい。
 */

import type { PressResult } from '@magic/server/engine';

/** localStorage のキー(deck-storage.ts と同じ名前空間付き命名)。 */
const STORAGE_KEY = 'magic:sound-muted';

/** マスター音量(控えめ・耳障りにしない)。全合成音はこのゲインを通す。 */
const MASTER_GAIN = 0.18;

/**
 * ミュート状態(true=消音)。表示の正はこの $state。getter 経由で参照箇所が
 * リアクティブに追従する(router.svelte.ts と同型)。既定は unmuted(false)。
 */
let muted = $state<boolean>(loadMuted());

/**
 * AudioContext は遅延生成する(初回 resume / 再生時)。生成できない環境では null のまま。
 * runes フィールドではない実装詳細なので $state にしない。
 */
let audioCtx: AudioContext | null = null;
/** AudioContext 生成を一度試みて失敗した(非対応環境)ことを記録し、再試行を避ける。 */
let audioUnavailable = false;

/** 保存済みミュート設定を読む。未保存・壊れ・例外時は既定(unmuted=false)。 */
function loadMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // SSR・プライベートブラウズ等で localStorage が使えない場合は既定。
    return false;
  }
}

/** ミュート設定を保存する。失敗(容量超過等)は握りつぶす(例外を投げない)。 */
function saveMuted(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // 保存できなくても再生機能には影響しないため無視する。
  }
}

/**
 * AudioContext を取得する(初回に遅延生成)。
 * 非対応環境(window / AudioContext が無い、生成例外)では null を返し、以後 no-op に倒す。
 */
function getCtx(): AudioContext | null {
  if (audioCtx !== null) {
    return audioCtx;
  }
  if (audioUnavailable) {
    return null;
  }
  // SSR・テスト等で window や AudioContext が無い環境では生成しない。
  const Ctor =
    typeof window !== 'undefined'
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (Ctor === undefined) {
    audioUnavailable = true;
    return null;
  }
  try {
    audioCtx = new Ctor();
    return audioCtx;
  } catch {
    audioUnavailable = true;
    return null;
  }
}

/**
 * 単音(オシレータ + 専用ゲイン)を鳴らす小さなヘルパー。
 * 速い指数減衰でクリック感を出す。ミュート時・非対応環境では呼ばれない前提。
 */
function tone(
  ctx: AudioContext,
  type: OscillatorType,
  freq: number,
  startAtMs: number,
  durationMs: number,
  peak: number
): void {
  const now = ctx.currentTime + startAtMs / 1000;
  const dur = durationMs / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  // 立ち上がりは即・減衰は指数(0 に達しないので十分小さい値へ)。
  gain.gain.setValueAtTime(peak, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur);
}

/** 打鍵音: 短いサイン波クリック(約 760Hz, 約 40ms, 速い減衰, 小音量)。 */
function playClick(ctx: AudioContext): void {
  tone(ctx, 'sine', 760, 0, 40, MASTER_GAIN);
}

/** エラー音: 低めの矩形短ブザー(約 180Hz, 約 100ms, やや硬め)。 */
function playError(ctx: AudioContext): void {
  tone(ctx, 'square', 180, 0, 100, MASTER_GAIN * 0.7);
}

/** 選択音: より高い極短サイン(約 1000Hz, 約 20ms, 打鍵より控えめ)。 */
function playSelectTone(ctx: AudioContext): void {
  tone(ctx, 'sine', 1000, 0, 20, MASTER_GAIN * 0.6);
}

/** 発動音: 上昇3音アルペジオ(C5-E5-G5 のサイン, 達成感, 計約 300ms)。 */
function playActivation(ctx: AudioContext): void {
  // C5 / E5 / G5 を時間差で重ねて鳴らす(各 ~130ms, 約 70ms ずつずらす)。
  tone(ctx, 'sine', 523.25, 0, 130, MASTER_GAIN * 0.8);
  tone(ctx, 'sine', 659.25, 70, 130, MASTER_GAIN * 0.8);
  tone(ctx, 'sine', 783.99, 140, 160, MASTER_GAIN * 0.9);
}

// ---- 公開 API ----

/** 現在のミュート状態を読む($state なので参照箇所がリアクティブに追従する)。 */
export function isMuted(): boolean {
  return muted;
}

/** ミュートを反転して localStorage に保存する。UI のトグルから呼ぶ。 */
export function toggleMute(): void {
  muted = !muted;
  saveMuted(muted);
}

/**
 * AudioContext を起動/再開する。バトル開始のユーザージェスチャ(スペース/クリック/
 * ロビーのボタン)から呼ぶことで、ブラウザの自動再生制約を回避する。
 * 非対応環境では no-op。suspended なら resume を試みる(失敗は握りつぶす)。
 */
export function resume(): void {
  const ctx = getCtx();
  if (ctx === null) {
    return;
  }
  if (ctx.state === 'suspended') {
    // resume は Promise を返すが待つ必要はない(失敗時も例外で落とさない)。
    void ctx.resume().catch(() => {});
  }
}

/**
 * 1 打鍵の結果(PressResult)に対応する音を鳴らす(ADR 0012 の対応表)。
 * - 'accepted' → 打鍵音
 * - 'mistyped' → エラー音
 * - 'activated' → 発動音
 * - 'buffered' / 'blocked' → 無音
 *   'buffered' はクールダウン中に構え済みカードへ打鍵し先行入力バッファへ積んだ瞬間で、
 *   仕様上「打った瞬間は無音」(ADR 0012)。配線側が press 前に明示ドレインしてもクールダウン
 *   状態は解除されないため、press 経路の pressKey は 'buffered' を返しうる(battle.ts /
 *   player-side.ts)。ここで無音にすることで「打った瞬間に鳴る/二重音/正誤確定前の嘘音」を
 *   防ぐ。受理ぶんはクールダウン明けの drainTypeahead が 'accepted'/'mistyped'/'activated'
 *   として返すので、正しいタイミングで漏れなく鳴る。
 * ミュート時・非対応環境では何もしない。
 */
export function playForResult(result: PressResult): void {
  if (muted) {
    return;
  }
  const ctx = getCtx();
  if (ctx === null || ctx.state !== 'running') {
    // resume されていない(ジェスチャ前)なら鳴らさない。嘘の遅延音を避ける。
    return;
  }
  switch (result) {
    case 'accepted':
      playClick(ctx);
      break;
    case 'mistyped':
      playError(ctx);
      break;
    case 'activated':
      playActivation(ctx);
      break;
    // 'buffered'(打った瞬間は無音)・'blocked'・その他は無音。
  }
}

/** カード選択(構え)が実際に変わった時に鳴らす控えめな音。ミュート時・非対応環境では no-op。 */
export function playSelect(): void {
  if (muted) {
    return;
  }
  const ctx = getCtx();
  if (ctx === null || ctx.state !== 'running') {
    return;
  }
  playSelectTone(ctx);
}
