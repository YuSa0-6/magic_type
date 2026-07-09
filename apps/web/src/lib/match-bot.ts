/**
 * オフライン対戦の簡易ボット駆動(v1, サーバー無し)。
 *
 * ADR 0011 のオンライン対戦が来るまでの繋ぎとして、相手陣を「一定間隔で適当なカードを
 * 選び、正しく打ち切る」スクリプトで動かす。本物の対戦相手は後続 B(server)が WebSocket で
 * 配線するため、これはあくまで UI とローカルエンジン挙動の確認用スタブである。
 *
 * 設計上の要点:
 * - ボットも自陣と同じ MatchEngine の API(selectCard / pressKey)だけを
 *   通して操作する。エンジンの内部には触れない(自陣プレイヤーと完全に対称)。
 * - 打鍵は romaji を再実装せず、エンジンが返す `remainingGuide` の先頭 1 文字を打つ。
 *   これでどんな読みでも常に「正しい次のキー」を打てる(誤入力 0 のボット)。
 * - rAF は使わない(ADR 0008)。Match 側の時間 tick(約 100ms)から step(now) を呼ぶ。
 */

import type { MatchEngine } from '@magic/server/engine';

/** ボットの強さプリセット。打鍵間隔(ミリ秒)で表す。小さいほど速い。 */
export interface BotConfig {
  /** 1 打鍵あたりの最小間隔(ミリ秒)。 */
  readonly keyIntervalMs: number;
  /** 発動後、次のカードを構えるまでの待ち(ミリ秒)。クールダウン中の空打ちを避ける。 */
  readonly selectDelayMs: number;
}

/** 既定のボット設定(人間の中級者くらい: 約 5 打/秒)。 */
export const DEFAULT_BOT: BotConfig = {
  keyIntervalMs: 200,
  selectDelayMs: 300,
};

/**
 * 1 体のボットを駆動する。指定 playerId 視点で MatchEngine を読み、自分の手を進める。
 * 状態(次に打てる時刻)を内部に持ち、step(now) が呼ばれるたびに高々 1 手進める。
 */
export class MatchBot {
  private readonly engine: MatchEngine;
  private readonly playerId: string;
  private readonly config: BotConfig;

  /** 次に打鍵/選択してよい最短時刻(ミリ秒)。間隔調整に使う。 */
  private nextActionAtMs = 0;

  constructor(engine: MatchEngine, playerId: string, config: BotConfig = DEFAULT_BOT) {
    this.engine = engine;
    this.playerId = playerId;
    this.config = config;
  }

  /**
   * 時刻 now でボットの手を最大 1 手進める。何か状態が変わったら true を返す
   * (呼び出し側がスナップショットを取り直す判断に使う)。
   *
   * 手順:
   * 1. 決着済みなら何もしない。
   * 2. まだ間隔が空いていなければ何もしない。
   * 3. カード未選択なら適当な 1 枚を構える。
   * 4. 選択中なら remainingGuide の先頭 1 文字を打つ。
   */
  step(now: number): boolean {
    const snap = this.engine.snapshot(this.playerId);
    if (snap.outcome.kind !== 'ongoing') {
      return false;
    }

    if (now < this.nextActionAtMs) {
      return false;
    }

    const self = snap.self;

    // 未選択 → 適当な手札を 1 枚構える(発動直後で selectedIndex が null になっている等)。
    if (self.selectedIndex === null) {
      const handIndex = this.pickCard(snap.self.hand.length, now);
      this.engine.selectCard(this.playerId, handIndex, now);
      this.nextActionAtMs = now + this.config.keyIntervalMs;
      return true;
    }

    // 選択中 → ガイドの先頭 1 文字を打つ。ガイドが空なら(取りこぼし防止で)待つ。
    const next = self.remainingGuide[0];
    if (next === undefined) {
      this.nextActionAtMs = now + this.config.keyIntervalMs;
      return false;
    }
    this.engine.pressKey(this.playerId, next, now);
    // 発動して手札が空いた直後は、次の構えまで少し間を置く(クールダウン中の空打ち回避)。
    const after = this.engine.snapshot(this.playerId);
    const justActivated = after.self.selectedIndex === null;
    this.nextActionAtMs =
      now + (justActivated ? this.config.selectDelayMs : this.config.keyIntervalMs);
    return true;
  }

  /**
   * 手札から構えるカードを選ぶ。決定論にこだわらない(ボットは権威でないため)。
   * 単純なローテーション(時刻ベース)で偏りなく全カードを使う。
   */
  private pickCard(handSize: number, now: number): number {
    if (handSize <= 0) {
      return 0;
    }
    return Math.floor(now / 1000) % handSize;
  }
}
