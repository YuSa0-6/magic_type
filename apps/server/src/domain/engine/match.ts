/**
 * 対戦(PvP)エンジンのコア(ADR 0011 #3)。
 *
 * 2 つの PlayerSide(陣営)を保持し、ある側の発動ダメージを相手側の HP へ適用して
 * 相互に HP を削り合うゲームを進める。フレームワーク非依存の純 TS(ADR 0002)で、
 * 状態を変えるメソッドは権威時刻 atMs を外部から受け取る(決定論, ADR 0009 #1)。
 *
 * 本 PR(A1)は MatchEngine コア(2陣営・相互HP・勝敗判定)まで。効果(Effect)の
 * 適用ロジックは後続 A2、serialize/restore・コマンドログは A3(ADR 0011 #4)。
 *
 * 勝敗の正(ADR 0010 #3/#14/#16):
 * - ある側の発動で相手 HP が 0 以下 → その側の win 候補。発動ごとに即終了させず、
 *   同一権威 atMs の全発動・全状態変更を適用しきった後に一括で outcome を評価する。
 * - 同一 atMs で両者 0 以下なら draw。
 * - 制限時間(deadline = startAtMs + timeLimitMs)を超えた atMs で未決着なら残 HP の
 *   多い側 win、同値なら draw。
 *
 * rng は陣営ごと独立ストリーム(ADR 0011 #13)。共有マスター seed から各陣営へ
 * 決定論的に派生し、各陣営の山札 rng はその陣営のストリームでのみ消費する。
 */

import type { Card } from './cards.ts';
import { PlayerSide } from './player-side.ts';
import type { Activation, ActiveEffectView, PlayerSideDTO, PressResult } from './player-side.ts';

export type { PressResult } from './player-side.ts';
export type { ActiveEffectView } from './player-side.ts';
export type { PlayerSideDTO } from './player-side.ts';

/** 対戦の規定 HP・制限時間(ADR 0010 #10)。 */
export const MATCH_DEFAULT_HP = 80;
export const MATCH_DEFAULT_TIME_LIMIT_MS = 120_000;

/**
 * 結果の終了理由(ADR 0011 #12)。
 * - 'ko': 撃破(相手 HP 0)
 * - 'timeup': 制限時間切れ
 * - 'forfeit': 放棄(A1 では未使用だが型に用意, ADR 0011 #8)
 */
export type EndReason = 'ko' | 'timeup' | 'forfeit';

/**
 * ある視点から見た対戦結果(ADR 0011 #12)。
 * 'ongoing' は未決着、それ以外は決着。視点別に win/lose/draw/forfeit を返す。
 */
export type MatchOutcome =
  | { readonly kind: 'ongoing' }
  | {
      readonly kind: 'win' | 'lose' | 'draw' | 'forfeit';
      readonly endReason: EndReason;
    };

/**
 * 権威的な決着結果(視点に依らない絶対結果)。MatchEngine が内部保持し、serialize の
 * MatchStateDTO にもそのまま載せる(プレーンデータ, ADR 0011 #4)。
 */
export type Resolution =
  | { readonly kind: 'ongoing' }
  | {
      readonly kind: 'resolved';
      /** 勝者の playerId。draw なら null。 */
      readonly winnerId: string | null;
      readonly endReason: EndReason;
    };

/**
 * ある視点(self / opponent)から見た 1 陣営の入力軸スナップショット(ADR 0008/0009 #5)。
 * atMs に依存しない値のみ。cooldown は時間軸なので別(MatchTimers)に置く。
 */
export interface PlayerState {
  readonly hp: number;
  readonly maxHp: number;
  /** 現在のシールド残量(被弾の前段で消費する吸収バッファ, ADR 0010 #14)。 */
  readonly shield: number;
  readonly hand: readonly Card[];
  readonly selectedIndex: number | null;
  readonly typedRomaji: string;
  readonly remainingGuide: string;
  readonly castMistypes: number;
  readonly drawPileCount: number;
  readonly discardPileCount: number;
  /**
   * 持続中の時限効果(haste/slow, ADR 0010 #5/#13)。失効は参照側が atMs と
   * expiresAtMs を比較して判定する(遅延評価)。残り窓は snapshotTimers 側で扱う。
   */
  readonly activeEffects: readonly ActiveEffectView[];
}

/**
 * 入力軸スナップショット(ADR 0008)。playerId 視点で self / opponent を返す。
 * atMs 非依存。入力イベント後にのみ更新する。
 */
export interface MatchSnapshot {
  readonly self: PlayerState;
  readonly opponent: PlayerState;
  /** この視点から見た決着結果。 */
  readonly outcome: MatchOutcome;
}

/**
 * 時間軸スナップショット(ADR 0008)。playerId 視点で self / opponent を返す。
 * 時刻 atMs に依存する値のみ(軽量)。時間 tick(約100ms)で更新する。
 */
export interface MatchTimers {
  /** 対戦開始からの経過時間(ミリ秒)。未開始なら0。 */
  readonly elapsedMs: number;
  /** 残り時間(ミリ秒)。0 で下限。未開始なら制限時間そのもの。 */
  readonly remainingMs: number;
  /** 自陣のクールダウン残り(ミリ秒)。 */
  readonly selfCooldownRemainingMs: number;
  /** 相手陣のクールダウン残り(ミリ秒)。 */
  readonly opponentCooldownRemainingMs: number;
}

/** 対戦中に蓄積されるイベント(判別共用体)。視点に依らない絶対記録。 */
export type MatchEvent =
  | { readonly type: 'started'; readonly atMs: number }
  | {
      readonly type: 'selected';
      readonly playerId: string;
      readonly handIndex: number;
      readonly cardId: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'mistyped';
      readonly playerId: string;
      readonly cardId: string;
      readonly key: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'activated';
      readonly playerId: string;
      readonly cardId: string;
      readonly damage: number;
      readonly castTimeMs: number;
      readonly mistypes: number;
      readonly atMs: number;
    }
  | {
      readonly type: 'ended';
      /** 勝者の playerId。draw なら null。 */
      readonly winnerId: string | null;
      readonly endReason: EndReason;
      readonly atMs: number;
    };

/**
 * 状態を取り出し・復元できる決定論的な疑似乱数ストリーム(mulberry32, ADR 0009 #2/#4)。
 *
 * PlayerSide には `next`(= `() => number`)だけを渡すので per-side の公開境界は変えない。
 * MatchEngine 側は本オブジェクトを保持して、`getState`/`setState` で内部 32bit 状態を
 * serialize/restore する(ADR 0011 #4: from-snapshot で rng の消費位置まで完全復元)。
 * 「seed + 呼び出し回数」ではなく内部状態そのものを持つので、consumer が増えても壊れない。
 */
interface StatefulRng {
  /** [0, 1) を返す。PlayerSide にはこの関数(bind 済み)だけを渡す。 */
  next(): number;
  /** 現在の内部状態(32bit 符号付き整数)。serialize 用。 */
  getState(): number;
  /** 内部状態を復元する。restore 用。 */
  setState(state: number): void;
}

/**
 * コマンド(受理した入力の完全記録, ADR 0009 #3 / 0011 #4)。判別共用体。
 *
 * MatchEngine が受け取る状態変更入力(start / selectCard / pressKey)を
 * 時系列で 1:1 記録する。eventLog(発動・撃破などの絶対イベント=統計用)とは責務を分離し、
 * 「同一 config + この commands 列 → 同一状態」(決定論)で任意 tick を再構成する土台にする。
 * 内部 Candidate 形状や HP などの派生状態は持たず、純粋な入力だけを保持する。
 */
export type Command =
  | { readonly type: 'start'; readonly atMs: number }
  | {
      readonly type: 'select';
      readonly playerId: string;
      readonly handIndex: number;
      readonly atMs: number;
    }
  | {
      readonly type: 'press';
      readonly playerId: string;
      readonly key: string;
      readonly atMs: number;
    };

/**
 * mulberry32: 決定論的な疑似乱数生成器([0, 1) を返す)。内部状態を取り出し・復元できる
 * StatefulRng として返す。テストとマスター seed からの陣営派生に使う(ADR 0009 #2/#4)。
 */
function mulberry32(seed: number): StatefulRng {
  let s = seed | 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    getState() {
      return s;
    },
    setState(state: number) {
      s = state | 0;
    },
  };
}

/**
 * マスター seed と陣営インデックスから、陣営ごとに独立な rng ストリームを派生する
 * (ADR 0011 #13)。陣営インデックスを seed に畳み込むことで、各陣営の山札 shuffle/draw が
 * 互いに混ざらない独立ストリームになる。これで from-snapshot + replay と予測が一致し、
 * 相手の引き順も読めない。
 */
function deriveStream(masterSeed: number, sideIndex: number): StatefulRng {
  // 陣営インデックスを大きな奇数で攪拌してから seed に加える(0/1 の差を散らす)。
  return mulberry32((masterSeed ^ Math.imul(sideIndex + 1, 0x9e3779b1)) | 0);
}

export interface MatchPlayerConfig {
  /** 陣営の識別子。snapshot の視点指定に使う。 */
  readonly id: string;
  /** その陣営のデッキ。 */
  readonly deck: readonly Card[];
}

export interface MatchOptions {
  /** 初期 HP(両陣営共通)。既定 80(ADR 0010 #10)。 */
  readonly maxHp?: number;
  /** 制限時間(ミリ秒)。既定 120000(ADR 0010 #10)。 */
  readonly timeLimitMs?: number;
  /**
   * マスター seed(ADR 0009 #2 / 0011 #13)。陣営ごとに独立ストリームへ派生する。
   * 省略時はテスト容易性のため固定の既定 seed を使う(本番はサーバーが生成して渡す)。
   */
  readonly masterSeed?: number;
}

/**
 * 対戦の不変構成(ADR 0011 #4)。replay(fromCommands)/restore は「同一 config + コマンド列
 * もしくは状態 DTO」から再構成するため、両者の入口を 1 つの型に束ねる。players(各 deck)と
 * options(masterSeed/maxHp/timeLimitMs)で決定論の初期条件が完全に決まる。
 */
export interface MatchConfig {
  readonly players: readonly [MatchPlayerConfig, MatchPlayerConfig];
  readonly options?: MatchOptions;
}

/**
 * MatchEngine 全状態の直列化(プレーンデータ, ADR 0011 #4)。両陣営の状態に加えて、
 * 進行軸(開始時刻・決着・保留中 KO)を持つ。serialize → restore で中断なしと同一に続行できる。
 */
export interface MatchStateDTO {
  readonly startedAtMs: number | null;
  readonly resolution: Resolution;
  readonly pendingKoAtMs: number | null;
  readonly sides: readonly [PlayerSideDTO, PlayerSideDTO];
}

/** 既定マスター seed(省略時)。本番ではサーバーが生成した seed を渡す。 */
const DEFAULT_MASTER_SEED = 0x1234_5678;

export class MatchEngine {
  private readonly timeLimitMs: number;
  private readonly ids: readonly [string, string];
  private readonly sides: readonly [PlayerSide, PlayerSide];
  /** 陣営ごとの rng ストリーム(状態を serialize/restore するため参照を保持, ADR 0011 #4)。 */
  private readonly rngs: readonly [StatefulRng, StatefulRng];

  private startedAtMs: number | null = null;
  /** 権威的な決着結果(視点非依存)。一度決着したら不変。 */
  private resolution: Resolution = { kind: 'ongoing' };

  /**
   * 未評価の KO 判定が保留されている権威時刻(ADR 0010 #14 の「同一 atMs の全発動を
   * 適用しきった後に一括評価」を実現するための遅延評価ポイント)。
   * 発動でダメージを適用するたびに最新の atMs を立て、(a) 別 atMs の操作が来たとき、
   * (b) スナップショット/結果を読むとき、(c) 明示 flush 時に評価する。これにより
   * 同一 atMs で両陣営の発動が双方を 0 にした相打ちが draw として裁定される(#16)。
   * pressKey の発動は KO 評価を保留点に積むだけで確定しない。
   */
  private pendingKoAtMs: number | null = null;

  private readonly eventLog: MatchEvent[] = [];

  /**
   * 受理した入力を時系列で記録するコマンドログ(ADR 0009 #3 / 0011 #4)。
   * eventLog(統計・絶対記録)とは責務を分離した「受理打鍵の完全記録」で、同一 config と
   * この列から fromCommands で状態を完全再構成できる(決定論, ADR 0009 #1)。
   * start/selectCard/pressKey が append する。
   */
  private readonly commandLog: Command[] = [];

  constructor(players: readonly [MatchPlayerConfig, MatchPlayerConfig], options?: MatchOptions) {
    const maxHp = options?.maxHp ?? MATCH_DEFAULT_HP;
    this.timeLimitMs = options?.timeLimitMs ?? MATCH_DEFAULT_TIME_LIMIT_MS;
    const masterSeed = options?.masterSeed ?? DEFAULT_MASTER_SEED;

    if (players[0].id === players[1].id) {
      throw new Error('対戦の2陣営に同じ playerId は使えません');
    }

    this.ids = [players[0].id, players[1].id];
    this.rngs = [deriveStream(masterSeed, 0), deriveStream(masterSeed, 1)];
    this.sides = [
      new PlayerSide(players[0].deck, maxHp, this.rngs[0].next),
      new PlayerSide(players[1].deck, maxHp, this.rngs[1].next),
    ];
  }

  /** 対戦開始時刻を記録する。既に開始済みなら無視する。 */
  start(atMs: number): void {
    this.commandLog.push({ type: 'start', atMs });
    if (this.startedAtMs !== null) {
      return;
    }
    this.startedAtMs = atMs;
    this.eventLog.push({ type: 'started', atMs });
  }

  /** playerId を陣営インデックスに解決する。未知の id は例外。 */
  private indexOf(playerId: string): 0 | 1 {
    if (playerId === this.ids[0]) {
      return 0;
    }
    if (playerId === this.ids[1]) {
      return 1;
    }
    throw new Error(`未知の playerId です: ${playerId}`);
  }

  /**
   * 指定陣営が手札を選択する(構え)。決着後は無視する。
   * クールダウン中・詠唱中でも選択は可能(切り替えは進捗リセット)。
   */
  selectCard(playerId: string, handIndex: number, atMs: number): void {
    this.commandLog.push({ type: 'select', playerId, handIndex, atMs });
    // 別 atMs の操作が来たら、保留中の KO 判定を先に確定させる(同一 atMs バッチの締め)
    this.flushPendingKo(atMs);
    if (this.isResolved) {
      return;
    }
    const idx = this.indexOf(playerId);
    const selected = this.sides[idx].selectCard(handIndex);
    if (selected !== null) {
      this.eventLog.push({
        type: 'selected',
        playerId,
        handIndex: selected.handIndex,
        cardId: selected.card.id,
        atMs,
      });
    }
  }

  /**
   * 指定陣営の1打鍵を処理する。発動が起きたらダメージを相手 HP へ適用するが、
   * **勝敗の確定はその場では行わず同一権威 atMs の保留点に積む**(ADR 0010 #14:
   * 同一 atMs の全発動・全状態変更を適用しきった後に一括評価)。確定は別 atMs の操作・
   * スナップショット参照・明示 flush のいずれかで起きる。これにより両陣営が同一 atMs で
   * 相手を 0 にした相打ちが draw として裁定される(#16)。
   */
  pressKey(playerId: string, key: string, atMs: number): PressResult {
    this.commandLog.push({ type: 'press', playerId, key, atMs });
    // 別 atMs の操作が来たら、保留中の KO 判定を先に確定させる(同一 atMs バッチの締め)
    this.flushPendingKo(atMs);
    if (this.isResolved) {
      return 'blocked';
    }
    const idx = this.indexOf(playerId);
    const { result, activation } = this.sides[idx].pressKey(key, atMs);

    if (activation !== null) {
      this.applyActivation(idx, activation);
      // KO 評価は即時に行わず同一 atMs の保留点に積む(ADR 0010 #14)
      this.pendingKoAtMs = atMs;
    }
    return result;
  }

  /**
   * 発動ダメージを相手 HP へ適用し、続けてカード効果を固定順で適用する(ADR 0010 #14/#15)。
   * 順序: ①ダメージ(相手 HP)→ ②自陣バフ(heal/shield/haste/sift)→ ③相手デバフ
   * (slow/discard)。1 カードの effects 配列内も同順で適用する。これで effects[] の評価が
   * 一意になり「同じ入力列 → 同じ状態」(ADR 0009 #1)を満たす。勝敗確定はしない
   * (同一 atMs の全発動・全効果を適用しきった後に MatchEngine が一括評価, #14④)。
   */
  private applyActivation(attackerIdx: 0 | 1, activation: Activation): void {
    const defenderIdx: 0 | 1 = attackerIdx === 0 ? 1 : 0;
    const attacker = this.sides[attackerIdx];
    const defender = this.sides[defenderIdx];

    // ①ダメージ(相手 HP へ。シールド控除→貫通分は takeDamage 内で解決, #14)
    defender.takeDamage(activation.damage);

    // ②自陣バフ → ③相手デバフ の固定順で効果を適用する(#15)。
    // 自陣バフ(heal/shield/haste/sift)を先に、相手デバフ(slow/discard)を後に。
    const atMs = activation.atMs;
    for (const effect of activation.effects) {
      switch (effect.kind) {
        case 'heal':
          attacker.heal(effect.amount);
          break;
        case 'shield':
          attacker.addShield(effect.amount, effect.capAmount);
          break;
        case 'haste':
          attacker.applyHaste(effect.ms, effect.durationMs, atMs);
          break;
        case 'sift':
          attacker.sift(effect.count);
          break;
      }
    }
    for (const effect of activation.effects) {
      switch (effect.kind) {
        case 'slow':
          defender.applySlow(effect.ms, effect.durationMs, atMs);
          break;
        case 'discard':
          defender.discardRandom();
          break;
      }
    }

    this.eventLog.push({
      type: 'activated',
      playerId: this.ids[attackerIdx],
      cardId: activation.cardId,
      damage: activation.damage,
      castTimeMs: activation.castTimeMs,
      mistypes: activation.mistypes,
      atMs: activation.atMs,
    });
  }

  /**
   * 保留中の KO 判定を「nextAtMs より前の権威時刻」のものに限り確定させる。
   * pressKey の発動は KO 評価を pendingKoAtMs に積むだけで確定しない。
   * 別 atMs の操作が来た時点で、それより前(= 同一 atMs バッチが閉じた)保留点を一括評価する。
   * nextAtMs を省略(参照系から呼ぶ)した場合は、保留があれば無条件に確定させる。
   */
  private flushPendingKo(nextAtMs?: number): void {
    if (this.pendingKoAtMs === null || this.isResolved) {
      this.pendingKoAtMs = null;
      return;
    }
    // 同一 atMs の操作が継続している間は確定を遅らせる(バッチ継続)。
    if (nextAtMs !== undefined && nextAtMs === this.pendingKoAtMs) {
      return;
    }
    this.evaluateKo(this.pendingKoAtMs);
    this.pendingKoAtMs = null;
  }

  /**
   * 撃破(KO)による勝敗を一括評価する(ADR 0010 #14 ④ / #16)。
   * 同一 atMs の全発動を適用しきった後に呼ぶ。両者 0 以下なら draw、
   * 片方のみ 0 以下ならもう一方の win。既に決着済み・両者健在なら何もしない。
   */
  private evaluateKo(atMs: number): void {
    if (this.isResolved) {
      return;
    }
    const d0 = this.sides[0].isDefeated;
    const d1 = this.sides[1].isDefeated;
    if (!d0 && !d1) {
      return;
    }
    let winnerId: string | null;
    if (d0 && d1) {
      winnerId = null; // 同一 atMs 両者0 → draw(ADR 0010 #16)
    } else if (d1) {
      winnerId = this.ids[0];
    } else {
      winnerId = this.ids[1];
    }
    this.resolve(winnerId, 'ko', atMs);
  }

  /**
   * 制限時間切れの勝敗を評価して反映する(ADR 0010 #3/#16)。
   * deadline = startAtMs + timeLimitMs を超えた atMs で未決着なら、残 HP の多い側 win、
   * 同値なら draw を outcome に反映する。deadline 未満・開始前・決着済みなら何もしない。
   * 戻り値は決着が起きたか(DO の権威タイマ ADR 0011 #10 が結果を読む経路)。
   */
  evaluateTimeUp(atMs: number): boolean {
    // 保留中の KO があれば先に確定させる(KO が時間切れより優先される)。
    this.flushPendingKo();
    if (this.isResolved || this.startedAtMs === null) {
      return false;
    }
    const deadline = this.startedAtMs + this.timeLimitMs;
    if (atMs < deadline) {
      return false;
    }
    const hp0 = this.sides[0].hp;
    const hp1 = this.sides[1].hp;
    let winnerId: string | null;
    if (hp0 > hp1) {
      winnerId = this.ids[0];
    } else if (hp1 > hp0) {
      winnerId = this.ids[1];
    } else {
      winnerId = null; // 残 HP 同値 → draw(ADR 0010 #16)
    }
    this.resolve(winnerId, 'timeup', atMs);
    return true;
  }

  /**
   * 放棄(forfeit)で決着させる(ADR 0011 #8/#12)。A1 では呼び出し経路を持たないが、
   * 結果軸の語彙として用意する。放棄した側の lose、相手の win。
   */
  forfeit(playerId: string, atMs: number): void {
    // 保留中の KO があれば先に確定させる(KO が放棄より優先される)。
    this.flushPendingKo();
    if (this.isResolved) {
      return;
    }
    const idx = this.indexOf(playerId);
    const winnerId = this.ids[idx === 0 ? 1 : 0];
    this.resolve(winnerId, 'forfeit', atMs);
  }

  /**
   * 保留中の KO 判定を明示的に確定させる(ADR 0010 #14 の一括評価点)。
   * 通常は別 atMs の操作やスナップショット参照で自動的に確定するが、最後の発動の後に
   * 何もせず結果を確定したい場合(例: DO の権威タイマや試合終了処理)に明示で呼べる。
   */
  flush(): void {
    this.flushPendingKo();
  }

  /** 権威的な決着を記録する(一度きり)。 */
  private resolve(winnerId: string | null, endReason: EndReason, atMs: number): void {
    this.resolution = { kind: 'resolved', winnerId, endReason };
    this.eventLog.push({ type: 'ended', winnerId, endReason, atMs });
  }

  private get isResolved(): boolean {
    return this.resolution.kind !== 'ongoing';
  }

  /** 対戦が決着済みか(視点非依存)。参照前に保留中の KO 判定を確定させる。 */
  get finished(): boolean {
    this.flushPendingKo();
    return this.isResolved;
  }

  /** 権威的な決着結果(視点非依存)。未決着は null。参照前に保留中の KO を確定させる。 */
  get result(): { winnerId: string | null; endReason: EndReason } | null {
    this.flushPendingKo();
    if (this.resolution.kind === 'ongoing') {
      return null;
    }
    return { winnerId: this.resolution.winnerId, endReason: this.resolution.endReason };
  }

  /** 指定視点での outcome を返す(ADR 0011 #12)。 */
  private outcomeFor(playerId: string): MatchOutcome {
    if (this.resolution.kind === 'ongoing') {
      return { kind: 'ongoing' };
    }
    const { winnerId, endReason } = this.resolution;
    if (winnerId === null) {
      return { kind: 'draw', endReason };
    }
    if (winnerId === playerId) {
      // 勝者は理由によらず win(forfeit 勝ちも win)。
      return { kind: 'win', endReason };
    }
    // 相手の放棄で勝ったのではなく、自分が放棄して負けた場合は forfeit、
    // それ以外(撃破負け・時間切れ負け)は通常の lose。
    if (endReason === 'forfeit') {
      return { kind: 'forfeit', endReason };
    }
    return { kind: 'lose', endReason };
  }

  /**
   * 入力軸スナップショット(ADR 0008)を指定視点で返す。
   * playerId が自陣(self)、もう一方が相手(opponent)になる。
   */
  snapshot(playerId: string): MatchSnapshot {
    this.flushPendingKo();
    const selfIdx = this.indexOf(playerId);
    const oppIdx: 0 | 1 = selfIdx === 0 ? 1 : 0;
    return {
      self: toPlayerState(this.sides[selfIdx].snapshot()),
      opponent: toPlayerState(this.sides[oppIdx].snapshot()),
      outcome: this.outcomeFor(playerId),
    };
  }

  /**
   * 時間軸スナップショット(ADR 0008)を指定視点で返す。時刻 atMs 依存(軽量)。
   * このメソッドは状態を変えない(時間切れ判定は evaluateTimeUp が権威的に行う)。
   */
  snapshotTimers(playerId: string, atMs: number): MatchTimers {
    const selfIdx = this.indexOf(playerId);
    const oppIdx: 0 | 1 = selfIdx === 0 ? 1 : 0;
    const elapsedMs = this.startedAtMs === null ? 0 : atMs - this.startedAtMs;
    return {
      elapsedMs,
      remainingMs: Math.max(0, this.timeLimitMs - elapsedMs),
      selfCooldownRemainingMs: this.sides[selfIdx].cooldownRemainingMs(atMs),
      opponentCooldownRemainingMs: this.sides[oppIdx].cooldownRemainingMs(atMs),
    };
  }

  /** 蓄積されたイベントログ(読み取り専用・視点非依存)。 */
  get events(): readonly MatchEvent[] {
    return this.eventLog;
  }

  /**
   * 受理した入力のコマンドログ(読み取り専用・視点非依存, ADR 0009 #3 / 0011 #4)。
   * eventLog とは別物。この列と同一 config から fromCommands で状態を完全再構成できる。
   */
  get commands(): readonly Command[] {
    return this.commandLog;
  }

  /**
   * コマンド列から状態を完全再構成する静的ファクトリ(ADR 0011 #4)。
   * 同一 config(players(deck) + options(masterSeed/maxHp/timeLimitMs))から新規エンジンを作り、
   * commands を記録時と同じ順に再適用する。決定論(ADR 0009 #1)により、再構成後の
   * snapshot(両視点)・outcome・eventLog は元エンジンの最終状態と一致する。
   * reconnect/和解はこの log replay で成立する(ADR 0011 #4)。
   */
  static fromCommands(config: MatchConfig, commands: readonly Command[]): MatchEngine {
    const engine = new MatchEngine(config.players, config.options);
    for (const cmd of commands) {
      switch (cmd.type) {
        case 'start':
          engine.start(cmd.atMs);
          break;
        case 'select':
          engine.selectCard(cmd.playerId, cmd.handIndex, cmd.atMs);
          break;
        case 'press':
          engine.pressKey(cmd.playerId, cmd.key, cmd.atMs);
          break;
      }
    }
    return engine;
  }

  /**
   * MatchEngine 全状態をプレーンデータへ直列化する(ADR 0011 #4)。
   * 進行中詠唱は内部 Candidate 形状を出さず selectedReading + typedKeys だけを持つ(ADR 0009 #4)。
   * rng は内部状態(消費位置)も含めるので、restore 後の draw 順まで完全に一致する。
   * 参照前に保留中の KO を確定させない(進行中の保留状態もそのまま保存する)。
   */
  serialize(): MatchStateDTO {
    return {
      startedAtMs: this.startedAtMs,
      resolution: this.resolution,
      pendingKoAtMs: this.pendingKoAtMs,
      sides: [
        this.sides[0].serialize(this.rngs[0].getState()),
        this.sides[1].serialize(this.rngs[1].getState()),
      ],
    };
  }

  /**
   * 直列化状態から MatchEngine を復元する静的ファクトリ(ADR 0011 #4)。
   * config から初期エンジンを作った後、DTO の全状態(両 side + 進行軸 + rng 消費位置)を
   * 上書きする。復元後に同じ入力で進めると、中断なしと同一結果になる(決定論)。
   * 進行中詠唱は DTO の typedKeys を新規 TypingSession へ流して内部 NFA を再構成する
   * (復元はエンジン内部に閉じる, ADR 0009 #4)。
   */
  static restore(config: MatchConfig, dto: MatchStateDTO): MatchEngine {
    const engine = new MatchEngine(config.players, config.options);
    engine.startedAtMs = dto.startedAtMs;
    engine.resolution = dto.resolution;
    engine.pendingKoAtMs = dto.pendingKoAtMs;
    // カード id → 実体の解決表(両陣営のデッキから。山札・捨て札・手札の全カードを含む)。
    const cardById = new Map<string, Card>();
    for (const p of config.players) {
      for (const c of p.deck) {
        cardById.set(c.id, c);
      }
    }
    engine.sides[0].restoreFrom(dto.sides[0], cardById);
    engine.sides[1].restoreFrom(dto.sides[1], cardById);
    engine.rngs[0].setState(dto.sides[0].rngState);
    engine.rngs[1].setState(dto.sides[1].rngState);
    return engine;
  }
}

/** PlayerSide の素データを PlayerState(公開型)へ写す。 */
function toPlayerState(s: ReturnType<PlayerSide['snapshot']>): PlayerState {
  return {
    hp: s.hp,
    maxHp: s.maxHp,
    shield: s.shield,
    hand: s.hand,
    selectedIndex: s.selectedIndex,
    typedRomaji: s.typedRomaji,
    remainingGuide: s.remainingGuide,
    castMistypes: s.castMistypes,
    drawPileCount: s.drawPileCount,
    discardPileCount: s.discardPileCount,
    activeEffects: s.activeEffects,
  };
}
