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

/** 短(読み11〜12字)・中(16〜17字)・長(23字)の5種 */
export const CARDS: readonly Card[] = [
  {
    id: 'spark',
    name: '火花',
    displayText: '紅き火花よ、弾けろ',
    reading: 'あかきひばなよはじけろ',
    damage: 5,
    cooldownMs: 1500,
  },
  {
    id: 'gale',
    name: '風刃',
    displayText: '風の刃よ、駆け抜けろ',
    reading: 'かぜのやいばよかけぬけろ',
    damage: 6,
    cooldownMs: 1500,
  },
  {
    id: 'blaze',
    name: '炎渦',
    displayText: '渦巻く炎よ、敵を包み込め',
    reading: 'うずまくほのおよてきをつつみこめ',
    damage: 10,
    cooldownMs: 1500,
  },
  {
    id: 'thunder',
    name: '雷撃',
    displayText: '天空の雷よ、敵を貫け',
    reading: 'てんくうのいかずちよてきをつらぬけ',
    damage: 11,
    cooldownMs: 1500,
  },
  {
    id: 'meteor',
    name: '流星雨',
    displayText: '天より降り注ぐ流星よ、敵を撃ち砕け',
    reading: 'てんよりふりそそぐりゅうせいよてきをうちくだけ',
    damage: 18,
    cooldownMs: 1500,
  },
];

/** 固定デッキ: 5種 × 各2枚 = 10枚(同種最大2枚の規則を満たす) */
export const STARTER_DECK: readonly Card[] = CARDS.flatMap((card) => [card, card]);
