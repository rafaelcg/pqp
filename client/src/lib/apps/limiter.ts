/**
 * A token bucket: `perSecond` tokens a second, holding at most `burst`. `take`
 * is a yes or no, never a wait, so a flood costs an app `rate-limited` answers
 * and the host nothing.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const at = this.now();
    const elapsed = Math.max(0, at - this.last) / 1000;
    this.last = at;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.perSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
