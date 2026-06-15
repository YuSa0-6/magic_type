/**
 * 自陣ローカル予測(B3 web, ADR 0011 #1/#9)。
 *
 * 範囲(v1 の現実的スコープ): **自陣の打鍵フィードバック(typedRomaji / remainingGuide /
 * 選択中カード / 詠唱進捗)だけ**をローカルの MatchEngine(@magic/server/engine = サーバーと
 * 同一の純 TS エンジン)で即時予測して表示する。これで自分のタイピングは RTT 待ちゼロになる。
 *
 * 権威表示(予測しない): HP・シールド・効果・クールダウン・相手陣・勝敗(outcome)は
 * サーバー push の state を正とする。予測詠唱が完了/権威で確定したら push の値へ整合し、
 * 差異が出たら権威優先で reconcile する(MatchScreen 側でマージ)。
 *
 * フルのロールバック和解(serialize/restore + replay で全状態を巻き戻す)は v1 では実装しない
 * (将来最適化, ADR 0011 に追記)。自陣予測=打鍵視覚のみ・ゲーム状態は権威表示、という分担で
 * 「即応(自分の打鍵)」と「公平(相手干渉はサーバー権威)」を両立しつつ実装を単純に保つ。
 *
 * seed と両デッキ(自分のは既知、相手はIDのみ)で初期化するが、相手デッキの中身は自陣の
 * 打鍵予測に影響しない(rng は陣営ごと独立ストリーム, ADR 0011 #13)。よって相手側は合法な
 * ダミーデッキで構成する(予測は self の入力軸しか読まないため整合は崩れない)。
 *
 * 時間軸(ADR 0011 #2): サーバーと同じウォール時計(Date.now())で start / select / press /
 * drain を打つ。予測は最新ローカル時刻で先行し、サーバーの遅延権威 push で HP 等を補正する。
 */

import { MatchEngine, type Card, type PlayerState } from '@magic/server/engine';

/** 予測が返す自陣の打鍵フィードバック(入力軸のうち視覚に関わる部分のみ)。 */
export interface SelfTypingPrediction {
  readonly hand: readonly Card[];
  readonly selectedIndex: number | null;
  readonly typedRomaji: string;
  readonly remainingGuide: string;
  readonly castMistypes: number;
}

/** 予測エンジンの最小スコープ ID(self は固定、opponent はダミー)。 */
const SELF = 'self';
const OPP = 'opp';

/**
 * 自陣の打鍵フィードバックをローカル予測する薄いラッパー。
 * 1 マッチ = 1 インスタンス。MatchEngine を内部に持ち、自陣の入力だけを流して
 * self の入力軸 snapshot を即時に返す(HP 等の権威は読まない)。
 */
export class SelfPredictor {
  private readonly engine: MatchEngine;

  /**
   * @param seed   matchStart の権威マスター seed(陣営ごと独立ストリームへ派生)。
   * @param selfDeck 自分のデッキ(解決済み Card 配列)。
   */
  constructor(seed: number, selfDeck: readonly Card[]) {
    // 相手はダミーの合法デッキ(self の打鍵予測には影響しない, ADR 0011 #13)。
    const dummyOpp = selfDeck.slice();
    this.engine = new MatchEngine(
      [
        { id: SELF, deck: selfDeck },
        { id: OPP, deck: dummyOpp },
      ],
      { masterSeed: seed }
    );
  }

  /** 予測の権威時計を開始する(matchStart 直後に 1 度)。 */
  start(atMs: number): void {
    this.engine.start(atMs);
  }

  /** 自陣の手札選択(構え)を予測へ反映する。 */
  select(handIndex: number, atMs: number): void {
    this.engine.selectCard(SELF, handIndex, atMs);
  }

  /** 自陣の 1 打鍵を予測へ反映する。受理可否は表示の即応に使う(権威は別途 push)。 */
  press(key: string, atMs: number): void {
    this.engine.pressKey(SELF, key, atMs);
  }

  /** クールダウン明け先行入力のドレイン(時間 tick 契機, ADR 0007)。 */
  drain(atMs: number): void {
    this.engine.drainTypeahead(SELF, atMs);
  }

  /** 現在の自陣打鍵フィードバックを返す(視覚のみ。HP/効果/CD は読まない)。 */
  snapshot(): SelfTypingPrediction {
    const self: PlayerState = this.engine.snapshot(SELF).self;
    return {
      hand: self.hand,
      selectedIndex: self.selectedIndex,
      typedRomaji: self.typedRomaji,
      remainingGuide: self.remainingGuide,
      castMistypes: self.castMistypes,
    };
  }
}
