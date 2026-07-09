import type { Effect } from '@magic/server/engine';

/** 手札4枚の扇配置の回転角(deg)。バトル画面間で共通(BattleScreen/MatchBattleScreen)。 */
export const HAND_ROTATIONS = [-6, -2, 2, 6];

/**
 * カード面に載せる効果テキスト(例「盾+8」「HP+6」「加速」)を組み立てる。
 * 表示専用の整形であり判定ではない(engine の Effect 型を import type で借りるのみ)。
 * 効果が無ければ null(純攻撃カードは効果テキスト行を出さない)。
 */
export function effectCardText(effects: readonly Effect[]): string | null {
  if (effects.length === 0) return null;
  return effects.map(effectLabel).join(' ');
}

function effectLabel(effect: Effect): string {
  switch (effect.kind) {
    case 'heal':
      return `HP+${effect.amount}`;
    case 'shield':
      return `盾+${effect.amount}`;
    case 'haste':
      return '加速';
    case 'slow':
      return '鈍化';
    case 'discard':
      return '手札破棄';
    case 'sift':
      return '山札整列';
  }
}
