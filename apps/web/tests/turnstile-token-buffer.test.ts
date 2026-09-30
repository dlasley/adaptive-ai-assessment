import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnstileTokenBuffer } from '@/lib/turnstile-token-buffer';

afterEach(() => {
  vi.useRealTimers();
});

describe('TurnstileTokenBuffer', () => {
  it('resolves wait() immediately when a token was delivered before it was called', async () => {
    const buffer = new TurnstileTokenBuffer();
    buffer.deliver('token-a');

    await expect(buffer.wait(1000)).resolves.toBe('token-a');
  });

  it('resolves wait() when a token is delivered after it was called', async () => {
    const buffer = new TurnstileTokenBuffer();
    const pending = buffer.wait(1000);
    buffer.deliver('token-b');

    await expect(pending).resolves.toBe('token-b');
  });

  it('does not let a consumed token be reused by a later wait()', async () => {
    const buffer = new TurnstileTokenBuffer();
    buffer.deliver('token-c');
    await expect(buffer.wait(1000)).resolves.toBe('token-c');

    // Nothing was delivered for this second wait, so it must time out
    // rather than resolve with the already-consumed token.
    await expect(buffer.wait(20)).resolves.toBeNull();
  });

  it('reject() discards a buffered token that was never consumed', async () => {
    const buffer = new TurnstileTokenBuffer();
    buffer.deliver('token-d');
    buffer.reject(); // simulates expiry before anyone called wait()

    await expect(buffer.wait(20)).resolves.toBeNull();
  });

  it('reject() resolves an in-flight wait() with null', async () => {
    const buffer = new TurnstileTokenBuffer();
    const pending = buffer.wait(1000);
    buffer.reject();

    await expect(pending).resolves.toBeNull();
  });

  it('times out and resolves with null when no token or rejection ever arrives', async () => {
    vi.useFakeTimers();
    const buffer = new TurnstileTokenBuffer();
    const pending = buffer.wait(1000);

    vi.advanceTimersByTime(1000);

    await expect(pending).resolves.toBeNull();
  });

  it('a deliver() that arrives after timeout is buffered for the next wait(), not lost', async () => {
    vi.useFakeTimers();
    const buffer = new TurnstileTokenBuffer();
    const pending = buffer.wait(1000);
    vi.advanceTimersByTime(1000);
    await expect(pending).resolves.toBeNull();

    buffer.deliver('late-token');
    vi.useRealTimers();

    await expect(buffer.wait(1000)).resolves.toBe('late-token');
  });

  it('a delivered token does not resolve an already-timed-out wait() twice', async () => {
    vi.useFakeTimers();
    const buffer = new TurnstileTokenBuffer();
    const pending = buffer.wait(1000);
    vi.advanceTimersByTime(1000);

    const outcome = await pending;
    vi.useRealTimers();

    expect(outcome).toBeNull();
  });

  it('clear() discards a buffered token', async () => {
    const buffer = new TurnstileTokenBuffer();
    buffer.deliver('token-e');
    buffer.clear();

    await expect(buffer.wait(20)).resolves.toBeNull();
  });

  it('clear() does not resolve an in-flight wait()', async () => {
    const buffer = new TurnstileTokenBuffer();
    const pending = buffer.wait(50);
    buffer.clear();

    // The waiter was discarded without being resolved; the wait() call
    // only settles via its own timeout.
    await expect(pending).resolves.toBeNull();
  });
});

describe('TurnstileTokenBuffer buffered token staleness', () => {
  it('still resolves a buffered token that is under the max age', async () => {
    vi.useFakeTimers();
    const buffer = new TurnstileTokenBuffer();
    buffer.deliver('token-f');
    vi.advanceTimersByTime(269_000);

    await expect(buffer.wait(1000)).resolves.toBe('token-f');
  });

  it('discards a buffered token at or past the max age instead of returning it', async () => {
    vi.useFakeTimers();
    const buffer = new TurnstileTokenBuffer();
    buffer.deliver('stale-token');
    vi.advanceTimersByTime(270_000);

    const pending = buffer.wait(1000);
    vi.advanceTimersByTime(1000);

    // The server's own 300s max-age check would have rejected this token
    // anyway; discarding it client-side avoids spending a verify()
    // attempt on a request that was always going to fail.
    await expect(pending).resolves.toBeNull();
  });

  it('calls onStaleTokenDiscarded only when a stale buffered token is actually discarded', async () => {
    vi.useFakeTimers();
    const onStaleTokenDiscarded = vi.fn();
    const buffer = new TurnstileTokenBuffer(onStaleTokenDiscarded);

    buffer.deliver('fresh-token');
    await expect(buffer.wait(1000)).resolves.toBe('fresh-token');
    expect(onStaleTokenDiscarded).not.toHaveBeenCalled();

    buffer.deliver('stale-token');
    vi.advanceTimersByTime(270_000);
    const pending = buffer.wait(1000);
    expect(onStaleTokenDiscarded).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    await expect(pending).resolves.toBeNull();
  });

  it('a fresh delivery after a stale discard resolves the waiting wait()', async () => {
    vi.useFakeTimers();
    const buffer = new TurnstileTokenBuffer();
    buffer.deliver('stale-token');
    vi.advanceTimersByTime(270_000);

    const pending = buffer.wait(1000);
    buffer.deliver('fresh-token');

    await expect(pending).resolves.toBe('fresh-token');
  });
});
