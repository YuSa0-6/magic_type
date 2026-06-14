/**
 * 対戦(PvP)エンジンの 1 陣営ぶんの状態と振る舞い(ADR 0011 #3)。
 *
 * BattleEngine(ソロ)の per-side 責務 — 山札シャッフル / 手札 / 捨て札 / ドロー、
 * カード選択(構え)、TypingSession 連携、クールダウン、先行入力ドレイン(ADR 0007)、
 * 詠唱計時、発動 — を再利用可能な単位として切り出したもの。フレームワーク非依存の
 * 純 TS(ADR 0002)で、状態を変えるメソッドは時刻 atMs を外部から受け取る。
 *
 * BattleEngine と異なり、PlayerSide は「相手の HP」を持たない。発動はダメージ値を
 * 返すだけで、HP への適用や勝敗判定は呼び出し側(MatchEngine)が両陣営をまたいで
 * 行う(ADR 0010 #14: 同一権威 atMs の全発動を適用しきった後に一括評価)。
 * 自陣 HP は被弾でのみ減るため PlayerSide が保持する。
 *
 * 効果(Effect)の適用(A2, ADR 0010 #5〜#9/#13〜#15)は本陣営の状態にのみ作用する:
 * heal(自陣 HP +)・shield(自陣シールド加算)・haste(自陣の次回 CD 短縮)・
 * sift(自陣山札の並べ替え)は自陣メソッドで適用し、slow(相手の次回 CD 延長)・
 * discard(相手手札の入れ替え)は MatchEngine が「相手側の PlayerSide」へ適用する。
 * haste/slow は進行中 CD には触れず、発動 atMs から durationMs の窓内に新規開始する
 * CD にのみ ±ms を遅延適用する(ADR 0010 #13)。スタックはリフレッシュ(同種は窓を
 * 上書き・延長せず、値は最大, ADR 0010 #9)。
 */

import type { Card } from './cards.ts';
import type { Effect } from './effects.ts';
import { TypingSession } from './romaji/session.ts';

/**
 * 持続中の時限効果(haste/slow)の内部表現(ADR 0010 #13)。
 * HP を毎 tick 増減するループは作らず、新規 CD 開始時に atMs で遅延評価する。
 * - kind: 'haste'(自陣の次回 CD を短縮)/ 'slow'(自陣の次回 CD を延長)。
 *   slow は MatchEngine が相手側の PlayerSide に対して付与する(相手デバフ, #15)。
 * - ms: CD への増減量(haste/slow とも正の数。符号は kind で解釈する)。
 * - expiresAtMs: 効果の有効窓の終端(この時刻以下に開始する CD にのみ適用)。
 */
interface TimedCdEffect {
  readonly kind: 'haste' | 'slow';
  ms: number;
  expiresAtMs: number;
}

/**
 * snapshot で公開する持続効果(ADR 0010 #5)。失効は atMs で判定するため、
 * 残り窓は時間軸(snapshotTimers)側に委ね、ここでは入力軸として種別と値のみ持つ。
 */
export interface ActiveEffectView {
  readonly kind: 'haste' | 'slow';
  readonly ms: number;
  readonly expiresAtMs: number;
}

/**
 * 1打鍵の結果(BattleEngine の PressResult と同義)。
 * - 'buffered' はクールダウン中の構え済み打鍵を先行入力バッファに積んだ状態(ADR 0007)。
 */
export type PressResult = 'accepted' | 'mistyped' | 'activated' | 'blocked' | 'buffered';

/**
 * 1 陣営ぶんの直列化状態(プレーンデータ, ADR 0009 #4 / 0011 #4)。
 * 内部 Candidate 形状は公開境界に出さない(#4)。進行中詠唱は selectedReading + typedKeys +
 * mistypes だけを持ち、restore 時にエンジン内部で TypingSession を再構成する。カードは id で
 * 持ち、restore 時に config の deck から実体へ解決する(DTO を小さく・プレーンに保つ)。
 */
export interface PlayerSideDTO {
  readonly hp: number;
  readonly shield: number;
  /** 山札(次に引くのは末尾)。カード id 列。 */
  readonly drawPile: readonly string[];
  /** 捨て札。カード id 列。 */
  readonly discardPile: readonly string[];
  /** 手札。カード id 列。 */
  readonly hand: readonly string[];
  readonly cooldownUntilMs: number;
  /** 進行中の時限効果(haste/slow)。 */
  readonly timedCdEffects: readonly {
    readonly kind: 'haste' | 'slow';
    readonly ms: number;
    readonly expiresAtMs: number;
  }[];
  readonly selectedIndex: number | null;
  /**
   * 進行中詠唱の途中状態(ADR 0009 #4)。詠唱中でなければ null。
   * selectedReading は再構成する読み、typedKeys は受理済みの打鍵列(誤入力は含めない)、
   * mistypes は現詠唱の誤入力数(ダメージ減衰に効くので別途保持する)。
   * restore はこの列を新規 TypingSession へ順に流して内部 NFA 状態を復元し、誤入力数を上書きする。
   */
  readonly cast: {
    readonly selectedReading: string;
    readonly typedKeys: readonly string[];
    readonly mistypes: number;
  } | null;
  /** 現詠唱の最初の受理打鍵時刻(まだなら null)。castTimeMs の起点。 */
  readonly castStartedAtMs: number | null;
  /** クールダウン中に積まれた先行入力バッファ(ADR 0007)。 */
  readonly typeahead: readonly string[];
  /** rng ストリームの内部状態(消費位置, ADR 0011 #4)。 */
  readonly rngState: number;
}

/**
 * 発動の結果(MatchEngine が相手 HP へ適用するための情報)。
 * applyKey / drainTypeahead の戻り値に同梱され、MatchEngine が回収する。
 */
export interface Activation {
  readonly cardId: string;
  /** 相手へ与えるダメージ(max(1, card.damage - 詠唱中誤入力数), ADR 0001)。 */
  readonly damage: number;
  /** 発動時に適用すべきカード効果(A1 では回収のみ・適用は A2)。 */
  readonly effects: readonly Effect[];
  /** 詠唱時間: 最初の受理打鍵から発動打鍵まで(ミリ秒)。 */
  readonly castTimeMs: number;
  /** 現詠唱の誤入力数。 */
  readonly mistypes: number;
  /** 発動の権威時刻。 */
  readonly atMs: number;
}

/**
 * 配列をシャッフルした新しい配列を返す(Fisher-Yates)。
 * rng は [0, 1) を返す関数。元配列は変更しない。
 */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const HAND_SIZE = 4;

/**
 * 先行入力バッファの上限(ADR 0007)。BattleEngine と同値。
 * 暴走防止の上限。現実の先行入力長を十分に上回る値にして、正当な入力を
 * 無音破棄しないようにする。
 */
const TYPEAHEAD_LIMIT = 64;

export class PlayerSide {
  readonly maxHp: number;
  private readonly rng: () => number;

  private hpValue: number;
  /** 自陣シールド残量(被弾の前段で消費する吸収バッファ, ADR 0010 #14)。 */
  private shieldValue = 0;
  private drawPile: Card[];
  private discardPile: Card[] = [];
  private hand: Card[] = [];

  /**
   * 持続中の時限効果(haste/slow)。新規 CD 開始時に窓内のものだけ atMs で適用する。
   * 同種はリフレッシュ(高々1つ, ADR 0010 #9)。
   */
  private timedCdEffects: TimedCdEffect[] = [];

  private selectedIndex: number | null = null;
  private session: TypingSession | null = null;
  /** 現詠唱で最初の受理打鍵が起きた時刻(まだなら null) */
  private castStartedAtMs: number | null = null;

  /** クールダウン中に構え済みカードへ打った打鍵の先行入力バッファ(ADR 0007) */
  private typeahead: string[] = [];

  private cooldownUntilMs = 0;

  /** この陣営が戦闘不能(HP 0 以下)になったか。勝敗の一括評価で参照する。 */
  private defeated = false;

  constructor(deck: readonly Card[], maxHp: number, rng: () => number) {
    this.maxHp = maxHp;
    this.rng = rng;
    this.hpValue = maxHp;

    // デッキをシャッフルして山札にし、手札4枚を引く
    this.drawPile = shuffle(deck, this.rng);
    for (let i = 0; i < HAND_SIZE; i++) {
      this.hand.push(this.drawOne());
    }
  }

  get hp(): number {
    return this.hpValue;
  }

  /** 現在のシールド残量(吸収バッファ)。 */
  get shield(): number {
    return this.shieldValue;
  }

  get isDefeated(): boolean {
    return this.defeated;
  }

  /**
   * 被弾でこの陣営の HP を減らす(MatchEngine が相手の発動ダメージを適用する経路)。
   * ダメージ解決パイプライン(ADR 0010 #14): ①シールドから控除 → ②貫通分を HP から
   * 控除 → ③HP ≤ 0 を記録。シールドは `card.damage` に介入しない HP 前段の吸収バッファで
   * あり、ダメージ固定(ADR 0001)を侵さない。HP は 0 でクランプし、0 以下になったら
   * 戦闘不能フラグを立てる。勝敗確定そのものは行わない(同一 atMs の全発動適用後に一括評価)。
   */
  takeDamage(amount: number): void {
    // ①シールドから控除(残量を超える分が貫通)
    const absorbed = Math.min(this.shieldValue, amount);
    this.shieldValue -= absorbed;
    const penetrating = amount - absorbed;
    // ②貫通分を HP から控除 → ③HP ≤ 0 を記録
    this.hpValue -= penetrating;
    if (this.hpValue <= 0) {
      this.hpValue = 0;
      this.defeated = true;
    }
  }

  /**
   * heal: 自陣 HP を amount 回復し maxHp でクランプする(ADR 0010 #14, 超過分は破棄)。
   * 自陣バフ(#15)。戦闘不能後の蘇生は想定しないため defeated は変えない。
   */
  heal(amount: number): void {
    this.hpValue = Math.min(this.maxHp, this.hpValue + amount);
  }

  /**
   * shield: 自陣シールドを上限付きで加算する(ADR 0010 #9/#14)。
   * 新シールド = min(現シールド + amount, capAmount)。既に上限以上なら据え置き(減らさない)。
   * 自陣バフ(#15)。
   */
  addShield(amount: number, capAmount: number): void {
    this.shieldValue = Math.min(Math.max(this.shieldValue, capAmount), this.shieldValue + amount);
  }

  /**
   * haste: 自陣の「次回以降に開始する CD」を、発動 atMs から durationMs の窓内で ms 短縮する
   * (ADR 0010 #13)。進行中 CD は変えない。スタックはリフレッシュ(同種は窓を上書き=
   * 延長せず、値は最大, ADR 0010 #9)。自陣バフ(#15)。
   */
  applyHaste(ms: number, durationMs: number, atMs: number): void {
    this.refreshTimedCdEffect('haste', ms, atMs + durationMs);
  }

  /**
   * slow: 自陣の「次回以降に開始する CD」を窓内で ms 延長する(ADR 0010 #13)。
   * MatchEngine が相手側の PlayerSide に対して呼ぶ(相手デバフ, #15)。打鍵には干渉しない(#2)。
   * スタックはリフレッシュ(同種は窓を上書き・値は最大, ADR 0010 #9)。
   */
  applySlow(ms: number, durationMs: number, atMs: number): void {
    this.refreshTimedCdEffect('slow', ms, atMs + durationMs);
  }

  /**
   * 同種の時限 CD 効果をリフレッシュする(ADR 0010 #9)。
   * 同種が既にあれば「窓は上書き(延長しない=新しい expiresAtMs を採る)・値は最大」。
   * なければ追加する。高々1種につき1つに保つ。
   */
  private refreshTimedCdEffect(kind: 'haste' | 'slow', ms: number, expiresAtMs: number): void {
    const existing = this.timedCdEffects.find((e) => e.kind === kind);
    if (existing) {
      existing.ms = Math.max(existing.ms, ms);
      existing.expiresAtMs = expiresAtMs;
    } else {
      this.timedCdEffects.push({ kind, ms, expiresAtMs });
    }
  }

  /**
   * 新規 CD を開始する時刻 atMs で、窓内に有効な haste/slow を合算した CD 増減量を返す。
   * haste は短縮(−ms)、slow は延長(+ms)。失効(atMs > expiresAtMs)は無視する(遅延評価)。
   */
  private cdDeltaAt(atMs: number): number {
    let delta = 0;
    for (const e of this.timedCdEffects) {
      if (atMs <= e.expiresAtMs) {
        delta += e.kind === 'haste' ? -e.ms : e.ms;
      }
    }
    return delta;
  }

  /**
   * sift: 自陣山札の上 count 枚を見て、最大 damage のカードを先頭(次に引く位置)へ移す
   * (ADR 0010 v1 解釈)。本来仕様(プレイヤーが任意順に並べ替える)はコマンドを要するため
   * 後回しで、ここでは「上 count 枚のうち最大 damage を次ドローへ」だけを決定論的に行う。
   * drawPile の末尾が次ドロー位置(drawOne は pop)なので、対象範囲は末尾 count 枚。
   * 同 damage が複数あるときは元の並びで末尾に近い(より先に引く)方を優先し安定にする。
   * 山札が空・count≤0 なら no-op。
   */
  sift(count: number): void {
    if (count <= 0 || this.drawPile.length === 0) {
      return;
    }
    const n = Math.min(count, this.drawPile.length);
    const top = this.drawPile.length - 1; // 次ドロー位置(末尾)
    // 末尾 n 枚 [top-n+1 .. top] のうち最大 damage の index を探す。
    // 同値は top に近い方を優先(>= ではなく、末尾から探索して最初に見つかった最大)。
    let bestIdx = top;
    let bestDamage = this.drawPile[top].damage;
    for (let i = top; i > top - n; i--) {
      if (this.drawPile[i].damage > bestDamage) {
        bestDamage = this.drawPile[i].damage;
        bestIdx = i;
      }
    }
    if (bestIdx !== top) {
      const [picked] = this.drawPile.splice(bestIdx, 1);
      this.drawPile.push(picked);
    }
  }

  /**
   * discard: この陣営(= 相手側)の手札からランダム1枚を捨て札へ送り、山札から1枚補充する
   * (ADR 0010 #8/#17)。MatchEngine が「相手側の PlayerSide」へ呼ぶ(相手デバフ, #15)。
   * - 選択/詠唱中のカード(selectedIndex)は対象外(#17)。
   * - ランダム選択はこの陣営の rng ストリームで行う(決定論, ADR 0011 #13)。
   * - 補充できない(山札+捨て札が空)場合は no-op(例外を投げない, #17)。
   * - 対象になりうる手札が無い(全て詠唱中など)場合も no-op。
   */
  discardRandom(): void {
    // 詠唱中カードを除いた候補 index を集める
    const candidates: number[] = [];
    for (let i = 0; i < this.hand.length; i++) {
      if (i !== this.selectedIndex) {
        candidates.push(i);
      }
    }
    if (candidates.length === 0) {
      return;
    }
    // 補充不能(山札も捨て札も空)なら no-op(手札を減らさない)
    if (this.drawPile.length === 0 && this.discardPile.length === 0) {
      return;
    }
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    const removed = this.hand[pick];
    this.discardPile.push(removed);
    this.hand[pick] = this.drawOne();
  }

  /**
   * 手札0〜3を選択する(構え)。クールダウン中でも選択自体は可能。
   * 詠唱中に別カードへ切り替えると進捗は完全にリセットされる
   * (誤入力カウントも先行入力バッファもリセット)。
   * 同じカードの再選択は無視する(誤って同じキーを押しても進捗を失わない)。
   * 戻り値は選択したカード(MatchEngine がイベント記録に使う)。null は無視されたとき。
   */
  selectCard(handIndex: number): { card: Card; handIndex: number } | null {
    if (handIndex < 0 || handIndex >= this.hand.length) {
      throw new Error(`手札インデックスが範囲外です: ${handIndex}`);
    }
    if (handIndex === this.selectedIndex) {
      return null;
    }
    this.selectedIndex = handIndex;
    const card = this.hand[handIndex];
    this.session = new TypingSession(card.reading);
    this.castStartedAtMs = null;
    this.typeahead = [];
    return { card, handIndex };
  }

  /**
   * 1打鍵を処理する。返り値は { result, activation }。
   * activation は発動が起きたときのみ非 null。MatchEngine がそれを相手 HP へ適用する。
   *
   * 先頭で drainTypeahead を呼び、保留中の先行入力を順序通りに先へ流してから生打鍵を扱う
   * (BattleEngine と同じ。ADR 0007 の打鍵順逆転バグ対策)。ドレインで発動が起きた場合は
   * その発動を持ち帰り、続く生打鍵は session が消えるため blocked になる。
   */
  pressKey(key: string, atMs: number): { result: PressResult; activation: Activation | null } {
    // 保留中の先行入力を先へ流す(クールダウン中・空・セッション無しなら no-op)
    const drained = this.drainTypeahead(atMs);

    if (this.selectedIndex === null || this.session === null) {
      // ドレインで発動が起きていれば、それを持ち帰る(生打鍵自体は blocked)
      return { result: 'blocked', activation: drained };
    }
    // クールダウン中は捨てずに先行入力バッファへ積む(明けに drainTypeahead で受理)
    if (this.isOnCooldown(atMs)) {
      if (this.typeahead.length < TYPEAHEAD_LIMIT) {
        this.typeahead.push(key);
      }
      return { result: 'buffered', activation: drained };
    }

    const applied = this.applyKey(key, atMs);
    // ドレインと生打鍵の両方で発動はあり得ないが、念のため後勝ちで持ち帰る
    return { result: applied.result, activation: applied.activation ?? drained };
  }

  /**
   * クールダウン明けに先行入力バッファをまとめて受理する(ADR 0007)。
   * 受理時刻はクールダウン明けの時刻(cooldownUntilMs)で統一する。
   * 発動が起きたら Activation を返す(MatchEngine が相手 HP へ適用する)。
   * 発動でセッションが消えたら以降のバッファは破棄する。
   */
  drainTypeahead(atMs: number): Activation | null {
    if (this.isOnCooldown(atMs) || this.typeahead.length === 0 || this.session === null) {
      if (this.session === null) {
        this.typeahead = [];
      }
      return null;
    }

    const acceptAtMs = this.cooldownUntilMs;
    const buffered = this.typeahead;
    this.typeahead = [];

    let activation: Activation | null = null;
    for (const key of buffered) {
      if (this.session === null) {
        break;
      }
      const applied = this.applyKey(key, acceptAtMs);
      if (applied.activation !== null) {
        activation = applied.activation;
      }
    }
    return activation;
  }

  /**
   * ガード(未選択・クールダウン)を通った後の打鍵適用処理。
   * TypingSession へ委譲し、最初の受理で詠唱計測を開始、打ち切ったら発動する。
   */
  private applyKey(
    key: string,
    atMs: number
  ): { result: PressResult; activation: Activation | null } {
    const result = (this.session as TypingSession).acceptKey(key);

    if (result === 'mistyped') {
      return { result: 'mistyped', activation: null };
    }

    if (this.castStartedAtMs === null) {
      this.castStartedAtMs = atMs;
    }

    if (result === 'completed') {
      const activation = this.activate(this.hand[this.selectedIndex as number], atMs);
      return { result: 'activated', activation };
    }
    return { result: 'accepted', activation: null };
  }

  /**
   * カードを発動し、捨て札・補充・クールダウン開始を行う。
   * ダメージは「相手の HP」へ適用するため、ここでは HP に触れず Activation として返す
   * (ADR 0010 #14: 勝敗確定は MatchEngine が一括で行う)。
   */
  private activate(card: Card, atMs: number): Activation {
    const mistypes = this.session?.mistypeCount ?? 0;
    const damage = Math.max(1, card.damage - mistypes);
    const castTimeMs = atMs - (this.castStartedAtMs ?? atMs);

    // 発動したカードを手札から外して捨て札へ、山札から1枚補充
    this.discardPile.push(card);
    this.hand[this.selectedIndex as number] = this.drawOne();

    this.selectedIndex = null;
    this.session = null;
    this.castStartedAtMs = null;
    // 新規 CD は窓内の haste/slow を反映する(進行中 CD には触れない, ADR 0010 #13)。
    // CD 長は 0 未満にならないようクランプする。
    const effectiveCdMs = Math.max(0, card.cooldownMs + this.cdDeltaAt(atMs));
    this.cooldownUntilMs = atMs + effectiveCdMs;

    return {
      cardId: card.id,
      damage,
      effects: card.effects,
      castTimeMs,
      mistypes,
      atMs,
    };
  }

  /**
   * 山札から1枚引く。山札が空なら捨て札をシャッフルして山札に戻す。
   * 山札も捨て札も空の場合は引けないため例外を投げる(通常は起きない)。
   */
  private drawOne(): Card {
    if (this.drawPile.length === 0) {
      if (this.discardPile.length === 0) {
        throw new Error('山札も捨て札も空でカードを引けません');
      }
      this.drawPile = shuffle(this.discardPile, this.rng);
      this.discardPile = [];
    }
    return this.drawPile.pop() as Card;
  }

  private isOnCooldown(atMs: number): boolean {
    return atMs < this.cooldownUntilMs;
  }

  /** クールダウンの残り時間(ミリ秒)。クールダウン外は0。時間軸スナップショット用。 */
  cooldownRemainingMs(atMs: number): number {
    return Math.max(0, this.cooldownUntilMs - atMs);
  }

  /**
   * 入力軸スナップショット用の素データ(atMs 非依存)。
   * activeEffects は現在保持している持続効果(haste/slow)を反映する。失効判定は
   * 参照側が atMs と expiresAtMs を比較して行う(ADR 0010 #4 の遅延評価。残り窓は
   * snapshotTimers 側で扱う)。
   */
  snapshot(): {
    hp: number;
    maxHp: number;
    shield: number;
    hand: readonly Card[];
    selectedIndex: number | null;
    typedRomaji: string;
    remainingGuide: string;
    castMistypes: number;
    drawPileCount: number;
    discardPileCount: number;
    activeEffects: readonly ActiveEffectView[];
  } {
    return {
      hp: this.hpValue,
      maxHp: this.maxHp,
      shield: this.shieldValue,
      hand: this.hand.slice(),
      selectedIndex: this.selectedIndex,
      typedRomaji: this.session?.typedRomaji ?? '',
      remainingGuide: this.session?.remainingGuide ?? '',
      castMistypes: this.session?.mistypeCount ?? 0,
      drawPileCount: this.drawPile.length,
      discardPileCount: this.discardPile.length,
      activeEffects: this.timedCdEffects.map((e) => ({
        kind: e.kind,
        ms: e.ms,
        expiresAtMs: e.expiresAtMs,
      })),
    };
  }

  /**
   * 1 陣営ぶんの全状態をプレーンデータへ直列化する(ADR 0011 #4)。
   * カードは id 列、進行中詠唱は受理済み打鍵列(typedKeys)と誤入力数だけにして、内部
   * Candidate 形状を公開境界に出さない(ADR 0009 #4)。rng の消費位置(内部状態)は
   * MatchEngine が StatefulRng から取り出して引数で渡す。
   */
  serialize(rngState: number): PlayerSideDTO {
    return {
      hp: this.hpValue,
      shield: this.shieldValue,
      drawPile: this.drawPile.map((c) => c.id),
      discardPile: this.discardPile.map((c) => c.id),
      hand: this.hand.map((c) => c.id),
      cooldownUntilMs: this.cooldownUntilMs,
      timedCdEffects: this.timedCdEffects.map((e) => ({
        kind: e.kind,
        ms: e.ms,
        expiresAtMs: e.expiresAtMs,
      })),
      selectedIndex: this.selectedIndex,
      cast:
        this.session === null
          ? null
          : {
              // 受理済み打鍵列(誤入力は含まない)。restore で新規 TypingSession へ流す。
              selectedReading: this.hand[this.selectedIndex as number].reading,
              typedKeys: [...this.session.typedRomaji],
              mistypes: this.session.mistypeCount,
            },
      castStartedAtMs: this.castStartedAtMs,
      typeahead: this.typeahead.slice(),
      rngState,
    };
  }

  /**
   * 直列化状態をこの陣営へ上書き復元する(ADR 0011 #4)。
   * カードは id を config 由来の解決表で実体へ戻し、進行中詠唱は TypingSession.restoreInProgress
   * で内部 NFA を再構成する(復元はエンジン内部に閉じる, ADR 0009 #4)。defeated は hp から導出。
   * rng の内部状態は MatchEngine 側が StatefulRng.setState で別途復元する。
   */
  restoreFrom(dto: PlayerSideDTO, cardById: ReadonlyMap<string, Card>): void {
    const resolve = (id: string): Card => {
      const c = cardById.get(id);
      if (c === undefined) {
        throw new Error(`復元できないカード id です: ${id}`);
      }
      return c;
    };
    this.hpValue = dto.hp;
    this.shieldValue = dto.shield;
    this.defeated = dto.hp <= 0;
    this.drawPile = dto.drawPile.map(resolve);
    this.discardPile = dto.discardPile.map(resolve);
    this.hand = dto.hand.map(resolve);
    this.cooldownUntilMs = dto.cooldownUntilMs;
    this.timedCdEffects = dto.timedCdEffects.map((e) => ({
      kind: e.kind,
      ms: e.ms,
      expiresAtMs: e.expiresAtMs,
    }));
    this.selectedIndex = dto.selectedIndex;
    this.castStartedAtMs = dto.castStartedAtMs;
    this.typeahead = dto.typeahead.slice();
    if (dto.cast === null) {
      this.session = null;
    } else {
      this.session = TypingSession.restoreInProgress(
        dto.cast.selectedReading,
        dto.cast.typedKeys,
        dto.cast.mistypes
      );
    }
  }

  /**
   * 上 count 枚の山札カード id を「次に引く順」で返す(テスト・デバッグ用の覗き見)。
   * drawOne は末尾から引くため、末尾を先頭に並べ替えて返す。
   */
  peekTopDrawPile(count: number): readonly string[] {
    const n = Math.min(count, this.drawPile.length);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.drawPile[this.drawPile.length - 1 - i].id);
    }
    return out;
  }
}
