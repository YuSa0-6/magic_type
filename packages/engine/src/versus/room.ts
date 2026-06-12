/**
 * 対戦モード(ADR 0002 の純TSドメイン層)の2人対戦バトルルーム。
 *
 * 設計の核: 各プレイヤーに専用の BattleEngine を1つずつ持たせて並走させる。
 * BattleEngine の「的HP」を相手プレイヤーのHPとみなし、先に相手のHPを
 * 削り切った(自分のエンジンが finished になった)側を勝者とする。
 * BattleEngine は変更せず、その public API のみを使う。
 *
 * サーバー権威の判定(ADR 0002)を担う中核であり、クライアントの自己申告は
 * 信用せず、このルームが打鍵を受けてエンジンで判定する想定。
 * 状態を変えるメソッドは時刻 atMs を外部から受け取り、内部では現在時刻を
 * 参照しない(テスト容易性のため。battle.ts と同方針)。
 */

import { BattleEngine, type BattleSnapshot, type PressResult } from '../battle.ts';
import type { Card } from '../cards.ts';

/** ルームの進行状態 */
export type VersusStatus = 'waiting' | 'ready' | 'inProgress' | 'finished';

/** 終了理由 */
export type VersusFinishReason = 'victory' | 'forfeit';

/** 相手プレイヤーの公開情報(手札・お題・入力途中は含めない) */
export interface OpponentView {
  readonly playerId: string;
  /** 相手の現在HP(=自分のエンジンの的HP) */
  readonly hp: number;
  /** 相手の最大HP */
  readonly maxHp: number;
  /** 相手が終了したか(=自分が削り切ったか) */
  readonly finished: boolean;
}

/** 対戦中の読み取り専用スナップショット(プレイヤー視点) */
export interface VersusSnapshot {
  readonly roomId: string;
  readonly status: VersusStatus;
  readonly winnerId: string | null;
  /** 自分の現在HP(=相手のエンジンの的HP)。相手の攻撃で減る。相手不在なら満タン */
  readonly ownHp: number;
  /** 自分の最大HP */
  readonly ownMaxHp: number;
  /** 自分側の完全なバトル状態(own.targetHp は相手のHPである点に注意) */
  readonly own: BattleSnapshot;
  /** 相手側の公開情報のみ */
  readonly opponent: OpponentView;
}

/** ルームに蓄積されるイベント(判別共用体) */
export type VersusEvent =
  | {
      readonly type: 'joined';
      readonly playerId: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'started';
      readonly atMs: number;
    }
  | {
      readonly type: 'finished';
      readonly winnerId: string;
      readonly reason: VersusFinishReason;
      readonly atMs: number;
    };

/** プレイヤーごとの席(エンジンと識別子の組) */
interface Seat {
  readonly playerId: string;
  readonly engine: BattleEngine;
}

const MAX_PLAYERS = 2;

export class VersusRoom {
  private readonly playerHp: number;
  private readonly rng: () => number;

  /** 参加した席(最大2)。join 順で並ぶ */
  private readonly seats: Seat[] = [];

  private statusValue: VersusStatus = 'waiting';
  private winnerIdValue: string | null = null;

  private readonly eventLog: VersusEvent[] = [];

  constructor(
    private readonly roomId: string,
    options?: { playerHp?: number; rng?: () => number }
  ) {
    this.playerHp = options?.playerHp ?? 50;
    this.rng = options?.rng ?? Math.random;
  }

  /**
   * ルームに参加する(自分のデッキを持ち込む)。
   * 各プレイヤーのエンジンの「的HP」は相手のHP(playerHp)として作る。
   * - 最大2人。3人目・重複 playerId はエラー
   * - 2人揃ったら status が 'ready' になる
   */
  join(playerId: string, deck: readonly Card[], atMs: number): void {
    if (this.seats.some((s) => s.playerId === playerId)) {
      throw new Error(`既に参加しているプレイヤーです: ${playerId}`);
    }
    if (this.seats.length >= MAX_PLAYERS) {
      throw new Error('ルームは満員です(最大2人)');
    }

    const engine = new BattleEngine(deck, { targetHp: this.playerHp, rng: this.rng });
    this.seats.push({ playerId, engine });
    this.eventLog.push({ type: 'joined', playerId, atMs });

    if (this.seats.length === MAX_PLAYERS) {
      this.statusValue = 'ready';
    }
  }

  /**
   * 対戦を開始する。'ready' のときのみ有効。
   * 両エンジンの start を呼び status を 'inProgress' へ。
   * それ以外の状態では何もしない。
   */
  start(atMs: number): void {
    if (this.statusValue !== 'ready') {
      return;
    }
    for (const seat of this.seats) {
      seat.engine.start(atMs);
    }
    this.statusValue = 'inProgress';
    this.eventLog.push({ type: 'started', atMs });
  }

  /**
   * カードを選択する(構え)。'inProgress' 中のみ有効、それ以外は何もしない。
   * 該当プレイヤーのエンジンへ委譲する。不明な playerId はエラー。
   */
  selectCard(playerId: string, handIndex: number, atMs: number): void {
    const seat = this.requireSeat(playerId);
    if (this.statusValue !== 'inProgress') {
      return;
    }
    seat.engine.selectCard(handIndex, atMs);
  }

  /**
   * 1打鍵を処理する。'inProgress' 中のみ有効、それ以外は 'blocked' を返す。
   * 該当プレイヤーのエンジンへ委譲し、その結果として相手HPを削り切ったら
   * (自分のエンジンが finished = 相手HP0)勝敗を確定する。
   * 不明な playerId はエラー。
   */
  pressKey(playerId: string, key: string, atMs: number): PressResult {
    const seat = this.requireSeat(playerId);
    if (this.statusValue !== 'inProgress') {
      return 'blocked';
    }
    const result = seat.engine.pressKey(key, atMs);
    // 自分のエンジンの finished = 相手HP0 = 自分の勝ち
    if (seat.engine.finished) {
      this.finish(seat.playerId, 'victory', atMs);
    }
    return result;
  }

  /**
   * 離脱する。相手の勝ちで即終了。'inProgress' 以外では何もしない。
   * 不明な playerId はエラー。
   */
  forfeit(playerId: string, atMs: number): void {
    this.requireSeat(playerId);
    if (this.statusValue !== 'inProgress') {
      return;
    }
    const opponent = this.seats.find((s) => s.playerId !== playerId);
    if (opponent === undefined) {
      return;
    }
    this.finish(opponent.playerId, 'forfeit', atMs);
  }

  /** 勝者を確定し status を 'finished' にする(既に終了済みなら無視) */
  private finish(winnerId: string, reason: VersusFinishReason, atMs: number): void {
    if (this.statusValue === 'finished') {
      return;
    }
    this.winnerIdValue = winnerId;
    this.statusValue = 'finished';
    this.eventLog.push({ type: 'finished', winnerId, reason, atMs });
  }

  /** playerId の席を取得する。なければエラー */
  private requireSeat(playerId: string): Seat {
    const seat = this.seats.find((s) => s.playerId === playerId);
    if (seat === undefined) {
      throw new Error(`このルームにいないプレイヤーです: ${playerId}`);
    }
    return seat;
  }

  get status(): VersusStatus {
    return this.statusValue;
  }

  get winnerId(): string | null {
    return this.winnerIdValue;
  }

  /**
   * プレイヤー視点の読み取り専用スナップショットを返す。
   * 自分側は BattleSnapshot をそのまま、相手側は公開情報のみ
   * (手札・お題・入力途中は含めない)。
   * 相手のHPは「自分のエンジンの targetHp」である点に注意。
   * 不明な playerId はエラー。
   */
  snapshotFor(playerId: string, atMs: number): VersusSnapshot {
    const own = this.requireSeat(playerId);
    const opponentSeat = this.seats.find((s) => s.playerId !== playerId);
    const ownSnapshot = own.engine.snapshot(atMs);

    // 相手HPは「自分のエンジンの的HP」。相手席がまだいなければ満タン扱い。
    const opponent: OpponentView = {
      playerId: opponentSeat?.playerId ?? '',
      hp: ownSnapshot.targetHp,
      maxHp: ownSnapshot.targetMaxHp,
      finished: own.engine.finished,
    };

    // 自分のHPは「相手のエンジンの的HP」。相手不在なら満タン。
    const ownHp = opponentSeat?.engine.snapshot(atMs).targetHp ?? this.playerHp;

    return {
      roomId: this.roomId,
      status: this.statusValue,
      winnerId: this.winnerIdValue,
      ownHp,
      ownMaxHp: this.playerHp,
      own: ownSnapshot,
      opponent,
    };
  }

  /** 蓄積されたイベントログ(読み取り専用) */
  get events(): readonly VersusEvent[] {
    return this.eventLog;
  }
}
