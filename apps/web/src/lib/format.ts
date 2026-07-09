/** ミリ秒を 0.1 秒単位の文字列に整形する(表示専用の整形であり判定ではない)。 */
export function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
