/**
 * 開始カウントダウンの秒送り(ADR 0008: rAF 不使用の setInterval)。
 * UI 状態のみを持ち、エンジンには一切触れない(呼び出し側が完了コールバックで
 * 実際の開始処理 = engine.start() 等を行う)。画面(タイムアタック/vsボット)ごとに
 * 独立したインスタンスを持つため、match-transport.svelte.ts と同じ「呼び出し側が
 * new する」パターンで公開する(ADR 0006。sound/router のようなアプリ全体で 1 つの
 * シングルトンとは性質が異なる)。
 */

const STEP_MS = 1000;
const GO_MS = 3000;
const DONE_MS = 3600;
const TICK_MS = 100;

export class Countdown {
  /** 3,2,1,'go' の表示値。進行していなければ null。 */
  value = $state<number | 'go' | null>(null);
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** カウントダウンを開始する。完了時に onDone を1回呼ぶ。 */
  begin(onDone: () => void): void {
    this.cancel();
    this.value = 3;
    const startedAt = performance.now();
    this.intervalId = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      if (elapsed >= DONE_MS) {
        this.cancel();
        onDone();
      } else if (elapsed >= GO_MS) {
        this.value = 'go';
      } else if (elapsed >= STEP_MS * 2) {
        this.value = 1;
      } else if (elapsed >= STEP_MS) {
        this.value = 2;
      }
    }, TICK_MS);
  }

  /** 進行中のカウントダウンを止める(画面離脱時の後始末等)。 */
  cancel(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.value = null;
  }
}
