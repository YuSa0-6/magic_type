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
 * ダミーデッキ(STARTER_DECK)で構成する(予測は self の入力軸しか読まないため整合は崩れない)。
 *
 * 陣営インデックス(B3 監査 should-fix): 各陣営の山札シャッフル/ドローは **side index 派生の
 * RNG ストリーム**(`deriveStream(masterSeed, sideIndex)`, ADR 0011 #13)に依存する。サーバー
 * 権威の MatchConfig.players は role 順(role0=side0 / role1=side1)で組まれるため、予測も
 * **self の実 role index** に self を置かないと side index がずれ、初期手札が権威と恒常的に
 * 食い違って reconcile が常にフォールバックする(role1=参加側の打鍵予測が効かない)。
 * よって self を players[role] に置き、もう一方をダミー相手で埋めて side index を権威に揃える。
 *
 * 時間軸(ADR 0011 #2): サーバーと同じウォール時計(Date.now())で start / select / press /
 * drain を打つ。予測は最新ローカル時刻で先行し、サーバーの遅延権威 push で HP 等を補正する。
 */

import { MatchEngine, STARTER_DECK, type Card, type PlayerState } from '@magic/server/engine';

/** 予測が返す自陣の打鍵フィードバック(入力軸のうち視覚に関わる部分のみ)。 */
export interface SelfTypingPrediction {
  readonly hand: readonly Card[];
  readonly selectedIndex: number | null;
  readonly typedRomaji: string;
  readonly remainingGuide: string;
  readonly castMistypes: number;
}

/**
 * ダミー相手のプレースホルダ ID。self の role と必ず異なる index を埋めるために使う。
 * self の実 id(selfId)と衝突しないよう固定の内部 ID を使う(相手側ストリームは
 * self の予測に影響しないが、id だけは MatchEngine の重複チェックに通る必要がある)。
 */
const DUMMY_OPP_ID = '__pred_opp__';

/**
 * 自陣の打鍵フィードバックをローカル予測する薄いラッパー。
 * 1 マッチ = 1 インスタンス。MatchEngine を内部に持ち、自陣の入力だけを流して
 * self の入力軸 snapshot を即時に返す(HP 等の権威は読まない)。
 */
export class SelfPredictor {
  private readonly engine: MatchEngine;
  /** snapshot / 入力で使う self の権威視点 ID(= matchStart の selfId)。 */
  private readonly selfId: string;

  /**
   * @param seed     matchStart の権威マスター seed(陣営ごと独立ストリームへ派生)。
   * @param selfRole 自分の role(0=作成側 / 1=参加側)。MatchEngine の side index と一致させる。
   * @param selfId   自分の権威視点 ID(matchStart の selfId)。snapshot 視点に使う。
   * @param selfDeck 自分のデッキ(解決済み Card 配列。権威へ提出したものと同一)。
   *
   * self を players[selfRole] に置き、もう一方の index をダミー相手で埋める。これで self の
   * side index が権威(role 順 MatchConfig)と一致し、`deriveStream(seed, selfRole)` の同一
   * ストリームで初期シャッフル/ドローが再現され、予測手札が権威 self 手札と一致する
   * (role 0/1 とも予測が効く, B3 監査 should-fix)。
   */
  constructor(seed: number, selfRole: 0 | 1, selfId: string, selfDeck: readonly Card[]) {
    this.selfId = selfId;
    // self の席(role index)へ実 id + 自デッキを、もう一方の席へダミー相手を置く。
    // 相手はダミーの合法デッキ(STARTER_DECK)。self の打鍵予測には影響しない(ADR 0011 #13)。
    const selfConfig = { id: selfId, deck: selfDeck };
    const dummyConfig = { id: DUMMY_OPP_ID, deck: STARTER_DECK };
    const players =
      selfRole === 0 ? ([selfConfig, dummyConfig] as const) : ([dummyConfig, selfConfig] as const);
    this.engine = new MatchEngine(players, { masterSeed: seed });
  }

  /** 予測の権威時計を開始する(matchStart 直後に 1 度)。 */
  start(atMs: number): void {
    this.engine.start(atMs);
  }

  /** 自陣の手札選択(構え)を予測へ反映する。 */
  select(handIndex: number, atMs: number): void {
    this.engine.selectCard(this.selfId, handIndex, atMs);
  }

  /** 自陣の 1 打鍵を予測へ反映する。受理可否は表示の即応に使う(権威は別途 push)。 */
  press(key: string, atMs: number): void {
    this.engine.pressKey(this.selfId, key, atMs);
  }

  /** クールダウン明け先行入力のドレイン(時間 tick 契機, ADR 0007)。 */
  drain(atMs: number): void {
    this.engine.drainTypeahead(this.selfId, atMs);
  }

  /** 現在の自陣打鍵フィードバックを返す(視覚のみ。HP/効果/CD は読まない)。 */
  snapshot(): SelfTypingPrediction {
    const self: PlayerState = this.engine.snapshot(this.selfId).self;
    return {
      hand: self.hand,
      selectedIndex: self.selectedIndex,
      typedRomaji: self.typedRomaji,
      remainingGuide: self.remainingGuide,
      castMistypes: self.castMistypes,
    };
  }
}
