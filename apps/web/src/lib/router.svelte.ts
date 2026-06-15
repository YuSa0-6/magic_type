/**
 * 依存ゼロの手書きルーティング(History API)。
 *
 * location.pathname を正としてルートを導出し、$state で公開する。
 * 既知のパスはそのページへ、それ以外(`/`・不明なパス)はホームへ倒す。
 * Cloudflare Workers の SPA フォールバック(not_found_handling: single-page-application)と
 * Vite dev の SPA フォールバックにより、各パスを直接開く・リロードしても 404 にならず
 * index.html が返る。
 */

/** アプリのルート種別 */
export type Route = 'home' | 'game' | 'match' | 'deck' | 'room';

/** ルートと URL パスの対応。導出(routeFromPath)と遷移(navigate)の両方をこの一覧から引く。 */
const PATHS: Record<Route, string> = {
  home: '/',
  game: '/game',
  // 対戦(PvP)関連(ADR 0010/0011)。v1 はオフライン(対ボット)+ デッキ編集 + ルームスタブ。
  match: '/match',
  deck: '/deck',
  room: '/room',
};

/** パス → ルートの逆引き表(未知のパスはホームに倒すため別管理)。 */
const ROUTE_BY_PATH: Record<string, Route> = Object.fromEntries(
  (Object.entries(PATHS) as [Route, string][]).map(([route, path]) => [path, route])
);

/** location.pathname からルートを導出する。未知のパスはホーム扱い。 */
function routeFromPath(pathname: string): Route {
  return ROUTE_BY_PATH[pathname] ?? 'home';
}

// 現在のルート。表示の正はこの $state。popstate の購読で戻る/進むに追従する。
let current = $state<Route>(routeFromPath(location.pathname));

/** 現在のルートを読み取る($state なので参照箇所がリアクティブに追従する)。 */
export function getRoute(): Route {
  return current;
}

/**
 * 指定ルートへ遷移する。
 * pushState は popstate を発火しないため、$state(current)も直接そろえる。
 * 同一パスでは履歴を積まない(同じ画面で履歴が無駄に増えるのを避ける)。
 */
export function navigate(to: Route): void {
  if (location.pathname !== PATHS[to]) {
    history.pushState({}, '', PATHS[to]);
  }
  current = to;
}

/**
 * <a> のクリックを横取りして SPA 遷移にする(フルリロードを防ぐ)。
 * 修飾キー付き・左以外のボタン(別タブ/新規ウィンドウ等)はブラウザ標準動作に委ねる。
 */
export function handleNavClick(e: MouseEvent, to: Route): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  e.preventDefault();
  navigate(to);
}

// ブラウザの戻る/進むに追従する(pushState 自体は発火しないため navigate 側で current を更新)。
// SPA のルートストアはアプリ生存中ずっと有効なので、購読は解除しない(意図的)。
window.addEventListener('popstate', () => {
  current = routeFromPath(location.pathname);
});
