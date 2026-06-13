/**
 * カード定義と固定デッキ。
 * お題(表示テキスト+読み)はカードに1対1で固定。
 * 読みの長さ=カードの強さで、長いほどダメージの伸びが大きい(非線形リターン)。
 */

export interface Card {
  /** カード種の識別子 */
  readonly id: string;
  readonly name: string;
  /** お題の表示テキスト(漢字かな交じり) */
  readonly displayText: string;
  /** お題の読み(かな)。判定の正 */
  readonly reading: string;
  /** 基本ダメージ。誤入力で減衰する */
  readonly damage: number;
  /** 発動後のクールダウン(ミリ秒) */
  readonly cooldownMs: number;
}

/**
 * 読み10〜25かなの10種(読み長順)。
 * damage/読み長 が読み長順に 0.300→0.640 で狭義単調増加し、
 * 長いお題ほど1かなあたりのダメージ効率が高い(ADR 0001 の非線形リターン)。
 */
export const CARDS: readonly Card[] = [
  {
    id: 'wave',
    name: '荒波',
    displayText: '荒波よ、敵を呑め',
    reading: 'あらなみよてきをのめ',
    damage: 3,
    cooldownMs: 1500,
  },
  {
    id: 'spark',
    name: '火花',
    displayText: '紅き火花よ、弾けろ',
    reading: 'あかきひばなよはじけろ',
    damage: 4,
    cooldownMs: 1500,
  },
  {
    id: 'gale',
    name: '風刃',
    displayText: '風の刃よ、駆け抜けろ',
    reading: 'かぜのやいばよかけぬけろ',
    damage: 5,
    cooldownMs: 1500,
  },
  {
    id: 'frost',
    name: '氷牢',
    displayText: '氷の檻よ、敵を捕らえろ',
    reading: 'こおりのおりよてきをとらえろ',
    damage: 6,
    cooldownMs: 1500,
  },
  {
    id: 'blaze',
    name: '炎渦',
    displayText: '渦巻く炎よ、敵を包み込め',
    reading: 'うずまくほのおよてきをつつみこめ',
    damage: 8,
    cooldownMs: 1500,
  },
  {
    id: 'thunder',
    name: '雷撃',
    displayText: '天空の雷よ、敵を貫け',
    reading: 'てんくうのいかずちよてきをつらぬけ',
    damage: 9,
    cooldownMs: 1500,
  },
  {
    id: 'ray',
    name: '光矢',
    displayText: '輝ける光の矢よ、敵を撃ち抜け',
    reading: 'かがやけるひかりのやよてきをうちぬけ',
    damage: 10,
    cooldownMs: 1500,
  },
  {
    id: 'chasm',
    name: '地淵',
    displayText: '揺るぎなき大地よ、敵を地底へと沈め',
    reading: 'ゆるぎなきだいちよてきをちていへとしずめ',
    damage: 12,
    cooldownMs: 1500,
  },
  {
    id: 'meteor',
    name: '流星雨',
    displayText: '天より降り注ぐ流星よ、敵を撃ち砕け',
    reading: 'てんよりふりそそぐりゅうせいよてきをうちくだけ',
    damage: 14,
    cooldownMs: 1500,
  },
  {
    id: 'abyss',
    name: '常闇',
    displayText: '奈落の底より這い上がる常闇よ、敵を蝕め',
    reading: 'ならくのそこよりはいあがるとこやみよてきをむしばめ',
    damage: 16,
    cooldownMs: 1500,
  },
];

/** 固定デッキ: 10種 × 各2枚 = 20枚(同種最大2枚の規則を満たす) */
export const STARTER_DECK: readonly Card[] = CARDS.flatMap((card) => [card, card]);
