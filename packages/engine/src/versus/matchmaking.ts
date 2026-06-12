/**
 * 対戦モード(ADR 0002 の純TSドメイン層)のランダムマッチング待機列。
 *
 * FIFO で待機者を2人ずつ組にする最小構成。サーバーがこの列を権威として持ち、
 * 成立した組をバトルルーム(VersusRoom)へ引き渡す想定。
 * 状態を変えるメソッドは時刻 atMs を外部から受け取り、内部では現在時刻を
 * 参照しない(テスト容易性のため。battle.ts と同方針)。
 */

/** マッチング成立時の組。players[0]=先に待っていた側、players[1]=後から来た側 */
export interface MatchPair {
  readonly players: readonly [string, string];
}

/** 待機列に蓄積されるイベント(判別共用体) */
export type MatchmakingEvent =
  | {
      readonly type: 'enqueued';
      readonly playerId: string;
      readonly atMs: number;
    }
  | {
      readonly type: 'matched';
      readonly players: readonly [string, string];
      readonly atMs: number;
    }
  | {
      readonly type: 'cancelled';
      readonly playerId: string;
      readonly atMs: number;
    };

/**
 * ランダムマッチングの待機列。
 *
 * enqueue で待機者がいれば即座に組にし、いなければ列の末尾に積む。
 * 同一 playerId の二重 enqueue はエラーとする(同じプレイヤーが複数枠を
 * 占有することを防ぐ)。
 */
export class MatchmakingQueue {
  /** 待機中の playerId(先頭ほど古い)。FIFO */
  private readonly queue: string[] = [];
  private readonly eventLog: MatchmakingEvent[] = [];

  /**
   * 待機列に入る。
   * - 既に待機者がいれば先頭と組にして両者を列から外し、MatchPair を返す
   * - いなければ列の末尾に積んで null を返す
   * - 既に待機中の playerId を再度 enqueue するとエラー
   */
  enqueue(playerId: string, atMs: number): MatchPair | null {
    if (this.queue.includes(playerId)) {
      throw new Error(`既に待機列にいるプレイヤーです: ${playerId}`);
    }

    const waiting = this.queue.shift();
    if (waiting === undefined) {
      // 相手がいないので末尾に積む
      this.queue.push(playerId);
      this.eventLog.push({ type: 'enqueued', playerId, atMs });
      return null;
    }

    // 先に待っていた側を players[0]、後から来た側を players[1] とする
    const players: readonly [string, string] = [waiting, playerId];
    this.eventLog.push({ type: 'matched', players, atMs });
    return { players };
  }

  /** 待機列から外す。列にいなければ何もしない(冪等) */
  cancel(playerId: string, atMs: number): void {
    const index = this.queue.indexOf(playerId);
    if (index === -1) {
      return;
    }
    this.queue.splice(index, 1);
    this.eventLog.push({ type: 'cancelled', playerId, atMs });
  }

  /** 現在の待機人数 */
  get waitingCount(): number {
    return this.queue.length;
  }

  /** 待機中の playerId 一覧(先頭ほど古い)の読み取り専用スナップショット */
  snapshot(): readonly string[] {
    return this.queue.slice();
  }

  /** 蓄積されたイベントログ(読み取り専用) */
  get events(): readonly MatchmakingEvent[] {
    return this.eventLog;
  }
}
