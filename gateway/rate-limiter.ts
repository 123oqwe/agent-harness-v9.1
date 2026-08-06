interface WindowEntry { timestamp: number; tokens: number }

export interface RateLimitConfig {
  rpmLimit: number;
  tpmLimit: number;
  concurrentLimit: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowEntry[]>();
  private readonly concurrent = new Map<string, number>();

  constructor(private readonly config: RateLimitConfig = { rpmLimit: 60, tpmLimit: 100_000, concurrentLimit: 5 }) {}

  check(userId: string, estTokens: number): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const windowStart = now - 60_000;
    let w = this.windows.get(userId);
    if (!w) { w = []; this.windows.set(userId, w); }
    w = w.filter(e => e.timestamp > windowStart);
    this.windows.set(userId, w);

    if (w.length >= this.config.rpmLimit) {
      return { allowed: false, reason: `RPM limit (${this.config.rpmLimit}/min)` };
    }
    const total = w.reduce((s, e) => s + e.tokens, 0);
    if (total + estTokens > this.config.tpmLimit) {
      return { allowed: false, reason: `TPM limit (${this.config.tpmLimit}/min)` };
    }
    const c = this.concurrent.get(userId) ?? 0;
    if (c >= this.config.concurrentLimit) {
      return { allowed: false, reason: `Concurrent limit (${this.config.concurrentLimit})` };
    }
    w.push({ timestamp: now, tokens: estTokens });
    this.concurrent.set(userId, c + 1);
    return { allowed: true };
  }

  release(userId: string): void {
    const c = this.concurrent.get(userId) ?? 0;
    this.concurrent.set(userId, Math.max(0, c - 1));
  }
}
