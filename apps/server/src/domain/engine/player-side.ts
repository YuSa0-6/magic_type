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
 * 効果(Effect)の適用は本 PR(A1)では行わない。activeEffects は型上の空配列で、
 * 適用ロジックは後続 A2 で追加する(ADR 0010 #5〜#9)。
 */

import type { Card } from './cards.ts';
import type { Effect } from './effects.ts';
import { TypingSession } from './romaji/session.ts';

/**
 * 1打鍵の結果(BattleEngine の PressResult と同義)。
 * - 'buffered' はクールダウン中の構え済み打鍵を先行入力バッファに積んだ状態(ADR 0007)。
 */
export type PressResult = 'accepted' | 'mistyped' | 'activated' | 'blocked' | 'buffered';

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
  private drawPile: Card[];
  private discardPile: Card[] = [];
  private hand: Card[] = [];

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

  get isDefeated(): boolean {
    return this.defeated;
  }

  /**
   * 被弾でこの陣営の HP を減らす(MatchEngine が相手の発動ダメージを適用する経路)。
   * HP は 0 でクランプし、0 以下になったら戦闘不能フラグを立てる。
   * 勝敗確定そのものは行わない(ADR 0010 #14: 同一 atMs の全発動適用後に一括評価)。
   *
   * A1 ではシールド(ADR 0010 #14 ①)は未実装。amount は素通しで HP から控除する。
   */
  takeDamage(amount: number): void {
    this.hpValue -= amount;
    if (this.hpValue <= 0) {
      this.hpValue = 0;
      this.defeated = true;
    }
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
    this.cooldownUntilMs = atMs + card.cooldownMs;

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

  /** 入力軸スナップショット用の素データ(atMs 非依存)。 */
  snapshot(): {
    hp: number;
    maxHp: number;
    hand: readonly Card[];
    selectedIndex: number | null;
    typedRomaji: string;
    remainingGuide: string;
    castMistypes: number;
    drawPileCount: number;
    discardPileCount: number;
    activeEffects: readonly Effect[];
  } {
    return {
      hp: this.hpValue,
      maxHp: this.maxHp,
      hand: this.hand.slice(),
      selectedIndex: this.selectedIndex,
      typedRomaji: this.session?.typedRomaji ?? '',
      remainingGuide: this.session?.remainingGuide ?? '',
      castMistypes: this.session?.mistypeCount ?? 0,
      drawPileCount: this.drawPile.length,
      discardPileCount: this.discardPile.length,
      // 効果適用は A2。A1 では常に空(ADR 0010 #5)。
      activeEffects: [],
    };
  }
}
