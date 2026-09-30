/**
 * Safety margin under the server's 300s max token age (MAX_TOKEN_AGE_MS
 * in src/lib/turnstile.ts). A buffered token this old or older is treated
 * as unusable and discarded rather than handed to a caller who would
 * spend it on a request the server rejects as token_expired.
 */
const MAX_BUFFERED_TOKEN_AGE_MS = 270_000;

/**
 * Single-slot handoff between the Turnstile widget's callbacks (which can
 * fire at any time, including before anyone is waiting) and a consumer
 * that calls wait() to get the next token. A token or rejection delivered
 * with no active waiter is buffered rather than dropped, so the delivery
 * order relative to wait() never matters. Framework-free so it can be
 * unit-tested without a DOM.
 */
export class TurnstileTokenBuffer {
  private token: string | null = null;
  private tokenDeliveredAt: number | null = null;
  private waiter: ((token: string | null) => void) | null = null;

  /**
   * @param onStaleTokenDiscarded Called when wait() finds a buffered
   * token too old to use. The widget that produced it isn't otherwise
   * told its work went unused, so without this hook nothing kicks off a
   * replacement challenge and a caller who arrives after the staleness
   * window would wait the full timeout for a delivery that never comes.
   */
  constructor(private readonly onStaleTokenDiscarded?: () => void) {}

  /** Called from the widget's success callback. Resolves a pending wait() immediately, or buffers the token for the next one. */
  deliver(token: string): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(token);
      return;
    }
    this.token = token;
    this.tokenDeliveredAt = Date.now();
  }

  /** Called from the widget's error/expired callbacks. Discards any buffered token — it's no longer valid — and wakes a pending waiter with null. */
  reject(): void {
    this.token = null;
    this.tokenDeliveredAt = null;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
  }

  /**
   * Resolves with a buffered token immediately if one is already waiting
   * and still fresh, otherwise waits for the next deliver()/reject()
   * call, up to timeoutMs. Resolves null on rejection or timeout. Only
   * one wait() can be in flight at a time — callers must await
   * completion before calling it again, which every caller in this
   * codebase already does.
   */
  wait(timeoutMs: number): Promise<string | null> {
    if (this.token !== null) {
      const token = this.token;
      const isStale =
        this.tokenDeliveredAt === null ||
        Date.now() - this.tokenDeliveredAt >= MAX_BUFFERED_TOKEN_AGE_MS;
      this.token = null;
      this.tokenDeliveredAt = null;

      if (!isStale) {
        return Promise.resolve(token);
      }
      this.onStaleTokenDiscarded?.();
      // Fall through to waiting for a fresh delivery instead of handing
      // the server a token it will reject.
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);

      this.waiter = (token) => {
        clearTimeout(timer);
        resolve(token);
      };
    });
  }

  /** Discards any buffered token and any in-flight waiter without resolving it. */
  clear(): void {
    this.token = null;
    this.tokenDeliveredAt = null;
    this.waiter = null;
  }
}
