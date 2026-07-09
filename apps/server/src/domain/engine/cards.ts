/**
 * カード定義と固定デッキ。
 * お題(表示テキスト+読み)はカードに1対1で固定。
 * 読みの長さ=カードの強さで、長いほどダメージの伸びが大きい(非線形リターン)。
 */

import type { Effect } from './effects.ts';

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
  /** 発動時に適用するカード効果(ADR 0010)。純攻撃カードは空配列 */
  readonly effects: readonly Effect[];
}

/**
 * 読み10〜25かなの10種(読み長順)。
 * damage/打鍵数 が読み長順に 0.158→0.354 で狭義単調増加し、
 * 長いお題ほど1打鍵あたりのダメージ効率が高い(ADR 0001 の非線形リターン)。
 */
export const CARDS: readonly Card[] = [
  {
    id: 'wave',
    name: '荒波',
    displayText: '荒波よ、敵を呑め',
    reading: 'あらなみよてきをのめ',
    damage: 3,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'spark',
    name: '火花',
    displayText: '紅き火花よ、弾けろ',
    reading: 'あかきひばなよはじけろ',
    damage: 4,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'gale',
    name: '風刃',
    displayText: '風の刃よ、駆け抜けろ',
    reading: 'かぜのやいばよかけぬけろ',
    damage: 5,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'frost',
    name: '氷牢',
    displayText: '氷の檻よ、敵を捕らえろ',
    reading: 'こおりのおりよてきをとらえろ',
    damage: 6,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'blaze',
    name: '炎渦',
    displayText: '渦巻く炎よ、敵を包み込め',
    reading: 'うずまくほのおよてきをつつみこめ',
    damage: 8,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'thunder',
    name: '雷撃',
    displayText: '天空の雷よ、敵を貫け',
    reading: 'てんくうのいかずちよてきをつらぬけ',
    damage: 9,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'ray',
    name: '光矢',
    displayText: '輝ける光の矢よ、敵を撃ち抜け',
    reading: 'かがやけるひかりのやよてきをうちぬけ',
    damage: 11,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'chasm',
    name: '地淵',
    displayText: '揺るぎなき大地よ、敵を地底へと沈め',
    reading: 'ゆるぎなきだいちよてきをちていへとしずめ',
    damage: 12,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'meteor',
    name: '流星雨',
    displayText: '天より降り注ぐ流星よ、敵を撃ち砕け',
    reading: 'てんよりふりそそぐりゅうせいよてきをうちくだけ',
    damage: 14,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'abyss',
    name: '常闇',
    displayText: '奈落の底より這い上がる常闇よ、敵を蝕め',
    reading: 'ならくのそこよりはいあがるとこやみよてきをむしばめ',
    damage: 17,
    cooldownMs: 1500,
    effects: [],
  },
];

/** 固定デッキ: 全10種 各1枚 + 軽い5種(wave〜blaze)をもう1枚 = 15枚(同種最大2枚の規則を満たす) */
export const STARTER_DECK: readonly Card[] = [...CARDS, ...CARDS.slice(0, 5)];

/**
 * 効果カード 6 枚(ADR 0010 #8 の v1 効果メニュー)。
 * 効果の通貨はお題長(詠唱時間)で、damage/打鍵 を純攻撃カードの曲線より下げた
 * サブ曲線に置く(ADR 0010 #6)。CARDS / STARTER_DECK には混ぜない(非破壊)。
 */
export const EFFECT_CARDS: readonly Card[] = [
  {
    id: 'mend',
    name: '癒し',
    displayText: '癒しの光よ、傷を塞げ',
    reading: 'いやしのひかりよきずをふさげ',
    damage: 3,
    cooldownMs: 1500,
    effects: [{ kind: 'heal', amount: 6 }],
  },
  {
    id: 'aegis',
    name: '守護',
    displayText: '守りの盾よ、我を庇え',
    reading: 'まもりのたてよわれをかばえ',
    damage: 2,
    cooldownMs: 1500,
    effects: [{ kind: 'shield', amount: 8, capAmount: 16 }],
  },
  {
    id: 'quicken',
    name: '加速',
    displayText: '時を速めよ、我に力を',
    reading: 'ときをはやめよわれにちからを',
    damage: 3,
    cooldownMs: 1500,
    effects: [{ kind: 'haste', ms: 700, durationMs: 6000 }],
  },
  {
    id: 'mire',
    name: '泥沼',
    displayText: '纏わりつく泥よ、相手を縛れ',
    reading: 'まとわりつくどろよあいてをしばれ',
    damage: 3,
    cooldownMs: 1500,
    effects: [{ kind: 'slow', ms: 700, durationMs: 6000 }],
  },
  {
    id: 'pilfer',
    name: '掠奪',
    displayText: '忍び寄る影よ、相手の手札を奪え',
    reading: 'しのびよるかげよあいてのてふだをうばえ',
    damage: 4,
    cooldownMs: 1500,
    effects: [{ kind: 'discard' }],
  },
  {
    id: 'foresee',
    name: '予見',
    displayText: '先を読む眼よ、山札を見通せ',
    reading: 'さきをよむめよやまふだをみとおせ',
    damage: 3,
    cooldownMs: 1500,
    effects: [{ kind: 'sift', count: 3 }],
  },
];

/**
 * クイックカード 5 枚(CONTEXT.md「クイックカード」)。
 * 詠唱が非常に短い純攻撃。絶対ダメージ(カードダメージ)は小さいが damage/打鍵 の効率は
 * 純攻撃の最短(wave 相当)より高く、長さ比例ダメージ(ADR 0001 の非線形リターン)の例外に置く。
 * 短い詠唱ゆえ詠唱時間 < クールダウンとなり、クールダウンが律速になる(ADR 0010 #12/#13)。
 * これによりテンポ軸(haste/slow による CD 伸縮)が初めて効く局面を作ること自体が価値で、
 * 絶対ダメージではない。実効DPSが暴れないよう CD は他カードと同じ 1500ms に揃え、damage を
 * 純攻撃の最小(wave=3)以下に切り詰めて抑える。CARDS / STARTER_DECK には混ぜない(非破壊)。
 */
export const QUICK_CARDS: readonly Card[] = [
  {
    id: 'flash',
    name: '閃光',
    displayText: '閃け',
    reading: 'ひらめけ',
    damage: 2,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'glint',
    name: '煌めき',
    displayText: '煌めけ',
    reading: 'きらめけ',
    damage: 2,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'rend',
    name: '斬撃',
    displayText: '斬り裂け',
    reading: 'きりさけ',
    damage: 2,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'pyre',
    name: '焔',
    displayText: '燃え上がれ',
    reading: 'もえあがれ',
    damage: 2,
    cooldownMs: 1500,
    effects: [],
  },
  {
    id: 'dash',
    name: '疾風',
    displayText: '駆け抜けろ',
    reading: 'かけぬけろ',
    damage: 3,
    cooldownMs: 1500,
    effects: [],
  },
];
