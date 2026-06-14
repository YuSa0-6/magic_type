/**
 * タイムアタック用バトルエンジン。
 *
 * 行動しないサンドバッグの的(一定HP)を倒すまでの時間を競う、ソロモードの最小構成。
 * フレームワーク非依存の純TS(ADR 0002)。状態を変えるメソッドは時刻 atMs を
 * 外部から受け取り、エンジン内では現在時刻を参照しない(テスト容易性のため)。
 *
 * ダメージは「正確性を発動条件、速度はテンポのみ」(ADR 0001)に従い、
 * 基本ダメージから詠唱中の誤入力数を引いた値(下限1)とする。
 */

import type { Card } from './cards';
import { TypingSession } from './romaji/session';

/**
 * 1打鍵の結果。
 * - 'buffered' はクールダウン中の構え済み打鍵を先行入力バッファに積んだ状態(ADR 0007)。
 */
export type PressResult = 'accepted' | 'mistyped' | 'activated' | 'blocked' | 'buffered';

/**
 * UI用の時間軸スナップショット(ADR 0008)。
 * 時刻 atMs に依存する値のみを持つ軽量な読み取り専用ビュー。
 * 時間 tick(約100ms)で更新される。
 */
export interface BattleTimers {
  /** バトル開始からの経過時間(ミリ秒)。未開始なら0 */
  readonly elapsedMs: number;
  /** クールダウンの残り時間(ミリ秒)。クールダウン外は0 */
  readonly cooldownRemainingMs: number;
}

/**
 * UI用の入力軸スナップショット(ADR 0008)。
 * 入力(打鍵・カード選択)で変わる値のみを持つ読み取り専用ビュー。
 * atMs に依存せず、入力イベント後にのみ更新される。
 * finished/clearTimeMs は発動打鍵で確定するイベント値なので入力軸に置く。
 */
export interface BattleState {
  /** 的の現在HP */
  readonly targetHp: number;
  /** 的の最大HP */
  readonly targetMaxHp: number;
  /** 手札(常に4枚) */
  readonly hand: readonly Card[];
  /** 選択中の手札インデックス(未選択なら null) */
  readonly selectedIndex: number | null;
  /** 現詠唱で入力済みのローマ字 */
  readonly typedRomaji: string;
  /** 残りの推奨ローマ字(動的ローマ字ガイド) */
  readonly remainingGuide: string;
  /** 現詠唱の誤入力数 */
  readonly castMistypes: number;
  /** 山札の残り枚数 */
  readonly drawPileCount: number;
  /** 捨て札の枚数 */
  readonly discardPileCount: number;
  /** 的を倒して終了したか */
  readonly finished: boolean;
  /** クリアタイム(ミリ秒)。未終了なら null */
  readonly clearTimeMs: number | null;
}

/** バトル中に蓄積されるイベント(判別共用体) */
export type BattleEvent =
  | {
      readonly type: 'started';
      readonly atMs: number;
    }
  | {
      readonly type: 'selected';
      readonly handIndex: number;
      readonly cardId: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'mistyped';
      readonly cardId: string;
      readonly key: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'activated';
      readonly cardId: string;
      readonly damage: number;
      /** 詠唱時間: 最初の受理打鍵から発動打鍵まで(ミリ秒) */
      readonly castTimeMs: number;
      readonly mistypes: number;
      readonly atMs: number;
    }
  | {
      readonly type: 'finished';
      readonly clearTimeMs: number;
      readonly atMs: number;
    };

/** カード種別ごとの集計 */
export interface CardStat {
  readonly cardId: string;
  /** 発動回数 */
  readonly activations: number;
  /** 平均詠唱時間(ミリ秒) */
  readonly averageCastTimeMs: number;
  /** 合計ダメージ */
  readonly totalDamage: number;
}

/** イベントログから集計した統計 */
export interface BattleStats {
  /** 総誤入力数(切り替えで捨てた詠唱の分も含む、累計) */
  readonly totalMistypes: number;
  /** カード種別ごとの集計(発動のあった種別のみ) */
  readonly perCard: readonly CardStat[];
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
 * 先行入力バッファの上限(ADR 0007)。
 * 暴走防止の上限。現実の先行入力長(どの読みの最大ローマ字長)を十分に上回る値にして、
 * 正当な入力を無音破棄しないようにする(クールダウン1500ms中の高速タイパーの打鍵数も賄える)。
 */
const TYPEAHEAD_LIMIT = 64;

export class BattleEngine {
  private readonly maxHp: number;
  private readonly rng: () => number;

  private hp: number;
  private drawPile: Card[];
  private discardPile: Card[] = [];
  private hand: Card[] = [];

  private selectedIndex: number | null = null;
  private session: TypingSession | null = null;
  /** 現詠唱で最初の受理打鍵が起きた時刻(まだなら null) */
  private castStartedAtMs: number | null = null;

  /** クールダウン中に構え済みカードへ打った打鍵の先行入力バッファ(ADR 0007) */
  private typeahead: string[] = [];

  private startedAtMs: number | null = null;
  private cooldownUntilMs = 0;
  private clearTimeMs: number | null = null;

  private readonly eventLog: BattleEvent[] = [];

  constructor(deck: readonly Card[], options?: { targetHp?: number; rng?: () => number }) {
    this.maxHp = options?.targetHp ?? 80;
    this.rng = options?.rng ?? Math.random;
    this.hp = this.maxHp;

    // デッキをシャッフルして山札にし、手札4枚を引く
    this.drawPile = shuffle(deck, this.rng);
    for (let i = 0; i < HAND_SIZE; i++) {
      this.hand.push(this.drawOne());
    }
  }

  /** バトル開始時刻を記録する。既に開始済みなら無視する */
  start(atMs: number): void {
    if (this.startedAtMs !== null) {
      return;
    }
    this.startedAtMs = atMs;
    this.eventLog.push({ type: 'started', atMs });
  }

  /**
   * 手札0〜3を選択する(構え)。クールダウン中・終了後でも選択自体は可能。
   * 詠唱中に別カードへ切り替えると進捗は完全にリセットされる
   * (その詠唱の誤入力カウントもリセット。統計の累計には計上済みのまま)。
   */
  selectCard(handIndex: number, atMs: number): void {
    if (this.finished) {
      return;
    }
    if (handIndex < 0 || handIndex >= this.hand.length) {
      throw new Error(`手札インデックスが範囲外です: ${handIndex}`);
    }
    // 同じカードの再選択は無視する(誤って同じキーを押しても進捗を失わない)
    if (handIndex === this.selectedIndex) {
      return;
    }
    this.selectedIndex = handIndex;
    const card = this.hand[handIndex];
    // 選択し直すたびに新しい詠唱セッションを作る(切り替え=進捗リセット)
    this.session = new TypingSession(card.reading);
    this.castStartedAtMs = null;
    // 別カードへ構え直すと先行入力バッファも進捗ごとリセットする(ADR 0007)
    this.typeahead = [];
    this.eventLog.push({ type: 'selected', handIndex, cardId: card.id, atMs });
  }

  /**
   * 1打鍵を処理する。
   * - カード未選択・終了後は 'blocked'(誤入力に数えない)
   * - クールダウン中は構え済み打鍵を先行入力バッファに積み 'buffered'(ADR 0007)
   * - それ以外は選択中カードの TypingSession に委譲し、打ち切ったら発動して 'activated'
   *
   * 先頭で drainTypeahead を呼び、保留中の先行入力を順序通りに先へ流してから
   * 生打鍵を扱う。これをしないと、クールダウン明け直後〜次の tick(最大~100ms)の窓で、
   * バッファ済み打鍵より後から来た生打鍵が先に適用され、打鍵順が逆転して
   * 偽の mistyped(ひいてはダメージ減衰)が起きる。
   * drainTypeahead はクールダウン中/バッファ空/セッション無しでは何もしない(no-op)。
   * ドレインで発動が起きてセッションが消える/新クールダウンが始まる場合に備え、
   * ドレイン後に finished/セッション/クールダウンのガードを評価し直す。
   */
  pressKey(key: string, atMs: number): PressResult {
    // 保留中の先行入力を順序通りに先へ流す(クールダウン中・空・セッション無しなら no-op)
    this.drainTypeahead(atMs);

    if (this.finished || this.selectedIndex === null || this.session === null) {
      return 'blocked';
    }
    // クールダウン中は捨てずに先行入力バッファへ積む(明けに drainTypeahead で受理)
    if (this.isOnCooldown(atMs)) {
      if (this.typeahead.length < TYPEAHEAD_LIMIT) {
        this.typeahead.push(key);
      }
      // 上限超過分は捨てるが、構え済みの打鍵という意味では受け付けたので 'buffered'
      return 'buffered';
    }

    return this.applyKey(key, atMs);
  }

  /**
   * クールダウン明けに先行入力バッファをまとめて受理する(ADR 0007)。
   * 受理時刻はクールダウン明けの時刻(cooldownUntilMs)で統一するため、
   * castStartedAtMs がクールダウン中まで遡らず、詠唱時間(ADR 0001)が壊れない。
   * 発動でセッションが消えたら以降のバッファは破棄する。
   * 1つでも適用したら true を返す(UI が入力軸スナップショットを取り直す判断に使う)。
   */
  drainTypeahead(atMs: number): boolean {
    if (this.isOnCooldown(atMs) || this.typeahead.length === 0 || this.session === null) {
      // ドレインできないときはバッファをそのまま保持する(まだクールダウン中など)
      if (this.session === null) {
        this.typeahead = [];
      }
      return false;
    }

    // 受理時刻はクールダウン明けの時刻に統一する(元の打鍵時刻は使わない)
    const acceptAtMs = this.cooldownUntilMs;
    const buffered = this.typeahead;
    this.typeahead = [];

    let applied = false;
    for (const key of buffered) {
      // 発動などでセッションが消えたら以降のバッファは破棄
      if (this.session === null) {
        break;
      }
      this.applyKey(key, acceptAtMs);
      applied = true;
    }
    return applied;
  }

  /**
   * ガード(終了・未選択・クールダウン)を通った後の打鍵適用処理。
   * TypingSession へ委譲し、最初の受理で詠唱計測を開始、打ち切ったら発動する。
   */
  private applyKey(key: string, atMs: number): PressResult {
    const card = this.hand[this.selectedIndex as number];
    const result = (this.session as TypingSession).acceptKey(key);

    if (result === 'mistyped') {
      this.eventLog.push({ type: 'mistyped', cardId: card.id, key, atMs });
      return 'mistyped';
    }

    // 最初の受理打鍵で詠唱時間の計測を開始する
    if (this.castStartedAtMs === null) {
      this.castStartedAtMs = atMs;
    }

    if (result === 'completed') {
      this.activate(card, atMs);
      return 'activated';
    }
    return 'accepted';
  }

  /** カードを発動し、ダメージ適用・捨て札・補充・クールダウン開始を行う */
  private activate(card: Card, atMs: number): void {
    const mistypes = this.session?.mistypeCount ?? 0;
    const damage = Math.max(1, card.damage - mistypes);
    const castTimeMs = atMs - (this.castStartedAtMs ?? atMs);

    this.hp -= damage;

    // 発動したカードを手札から外して捨て札へ、山札から1枚補充
    this.discardPile.push(card);
    this.hand[this.selectedIndex as number] = this.drawOne();

    this.selectedIndex = null;
    this.session = null;
    this.castStartedAtMs = null;
    this.cooldownUntilMs = atMs + card.cooldownMs;

    this.eventLog.push({
      type: 'activated',
      cardId: card.id,
      damage,
      castTimeMs,
      mistypes,
      atMs,
    });

    if (this.hp <= 0) {
      this.hp = 0;
      this.clearTimeMs = atMs - (this.startedAtMs ?? atMs);
      this.eventLog.push({ type: 'finished', clearTimeMs: this.clearTimeMs, atMs });
    }
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

  /** 時間軸スナップショット(時刻依存のみ・軽量)を返す。時間 tick で更新する */
  snapshotTimers(atMs: number): BattleTimers {
    return {
      elapsedMs: this.startedAtMs === null ? 0 : atMs - this.startedAtMs,
      cooldownRemainingMs: Math.max(0, this.cooldownUntilMs - atMs),
    };
  }

  /** 入力軸スナップショット(入力依存・atMs 不要)を返す。入力イベント後に更新する */
  snapshotState(): BattleState {
    return {
      targetHp: this.hp,
      targetMaxHp: this.maxHp,
      hand: this.hand.slice(),
      selectedIndex: this.selectedIndex,
      typedRomaji: this.session?.typedRomaji ?? '',
      remainingGuide: this.session?.remainingGuide ?? '',
      castMistypes: this.session?.mistypeCount ?? 0,
      drawPileCount: this.drawPile.length,
      discardPileCount: this.discardPile.length,
      finished: this.finished,
      clearTimeMs: this.clearTimeMs,
    };
  }

  /** 蓄積されたイベントログ(読み取り専用) */
  get events(): readonly BattleEvent[] {
    return this.eventLog;
  }

  get finished(): boolean {
    return this.clearTimeMs !== null;
  }

  /** イベントログから統計を集計する */
  stats(): BattleStats {
    let totalMistypes = 0;
    // カード種別ごとに 発動回数・詠唱時間合計・ダメージ合計 を集める
    const acc = new Map<string, { activations: number; castTimeSum: number; damageSum: number }>();

    for (const ev of this.eventLog) {
      if (ev.type === 'mistyped') {
        totalMistypes++;
      } else if (ev.type === 'activated') {
        const cur = acc.get(ev.cardId) ?? { activations: 0, castTimeSum: 0, damageSum: 0 };
        cur.activations++;
        cur.castTimeSum += ev.castTimeMs;
        cur.damageSum += ev.damage;
        acc.set(ev.cardId, cur);
      }
    }

    const perCard: CardStat[] = [];
    for (const [cardId, v] of acc) {
      perCard.push({
        cardId,
        activations: v.activations,
        averageCastTimeMs: v.castTimeSum / v.activations,
        totalDamage: v.damageSum,
      });
    }

    return { totalMistypes, perCard };
  }
}
