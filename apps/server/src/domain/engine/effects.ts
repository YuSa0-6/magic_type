/**
 * 対戦(PvP)のカード効果モデル(ADR 0010)。
 *
 * 効果は宣言的データ(判別共用体)で表す(ADR 0010 #5)。エンジンは kind ごとの
 * ハンドラで適用する。効果が操作してよいのは HP 軸・テンポ軸・カード経済軸の 3 つに
 * 限り、ダメージの数値そのものには触れない(ADR 0010 #7)。
 *
 * 本ファイルは型とデータの定義のみで、適用ロジック(BattleEngine 等)は別 PR。
 */

/**
 * カード効果の判別共用体(ADR 0010 #8)。
 *
 * - HP 軸: `heal` / `shield`
 * - テンポ軸: `haste` / `slow`(いずれも次回 CD のみに作用する時限効果, ADR 0010 #13)
 * - 経済軸: `discard` / `sift`
 *
 * 時限効果のスタックはリフレッシュ(上書き)規則(ADR 0010 #9)。
 */
export type Effect =
  /** 自陣 HP +amount(即時, 最大 HP 上限でクランプ)。amount <= 7(ADR 0010 #11)。 */
  | { readonly kind: 'heal'; readonly amount: number }
  /** 自陣シールド +amount(被弾で消費, 上限 capAmount 付き加算, ADR 0010 #9/#14)。 */
  | { readonly kind: 'shield'; readonly amount: number; readonly capAmount: number }
  /** 自分の次回 CD を durationMs の窓内で −ms(時限, ADR 0010 #13)。 */
  | { readonly kind: 'haste'; readonly ms: number; readonly durationMs: number }
  /** 相手の次回 CD を durationMs の窓内で +ms(時限, ADR 0010 #13)。 */
  | { readonly kind: 'slow'; readonly ms: number; readonly durationMs: number }
  /** 相手の手札からランダムに 1 枚破棄し山札から補充(即時, 枯渇時は no-op)。 */
  | { readonly kind: 'discard' }
  /** 自分の山札の上 count 枚を並べ替え(即時)。 */
  | { readonly kind: 'sift'; readonly count: number };
