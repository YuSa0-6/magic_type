/**
 * 依存ゼロの手書きハッシュルーティング。
 *
 * location.hash を正としてルートを導出し、$state で公開する。
 * `#/game` のみゲーム画面、それ以外(空・`#/`・不明なハッシュ)はホームへ倒す。
 * ハッシュベースなので GitHub Pages(base '/magic/')の静的配信でも 404 にならない。
 */

/** アプリのルート種別 */
export type Route = 'home' | 'game';

/** location.hash からルートを導出する。未知のハッシュはホーム扱い。 */
function routeFromHash(hash: string): Route {
  return hash === '#/game' ? 'game' : 'home';
}

// 現在のルート。表示の正はこの $state。hashchange の購読で追従する。
let current = $state<Route>(routeFromHash(location.hash));

/** 現在のルートを読み取る($state なので参照箇所がリアクティブに追従する)。 */
export function getRoute(): Route {
  return current;
}

/** 指定ルートへ遷移する。ハッシュを書き換えると hashchange 経由で current が更新される。 */
export function navigate(to: Route): void {
  const hash = to === 'game' ? '#/game' : '#/';
  if (location.hash === hash) {
    // ハッシュが同一だと hashchange が発火しないため、状態を直接そろえる。
    current = to;
    return;
  }
  location.hash = hash;
}

// ブラウザの戻る/進む・手動のハッシュ書き換えにも追従する。
// SPA のルートストアはアプリ生存中ずっと有効なので、購読は解除しない(意図的)。
window.addEventListener('hashchange', () => {
  current = routeFromHash(location.hash);
});
