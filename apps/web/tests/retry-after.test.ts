import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetryAfter } from '@/lib/retry-after';
import { evaluateWritingAnswer } from '@/lib/typed-answer-evaluation';
import { createStudyCode } from '@/lib/study-codes';

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchWithRetryAfter', () => {
  it('returns a non-429 response without waiting or retrying', async () => {
    fetchMock.mockResolvedValue(response(200));
    const onBusy = vi.fn();

    const result = await fetchWithRetryAfter('/x', {}, onBusy);

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onBusy).not.toHaveBeenCalled();
  });

  it('on a 429 waits the Retry-After seconds, reports busy, and retries once', async () => {
    fetchMock.mockResolvedValueOnce(response(429, {}, { 'Retry-After': '7' })).mockResolvedValueOnce(response(200));
    const onBusy = vi.fn();

    const pending = fetchWithRetryAfter('/x', {}, onBusy);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onBusy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries only once, returning a second 429 as it is', async () => {
    fetchMock.mockResolvedValue(response(429, {}, { 'Retry-After': '1' }));

    const pending = fetchWithRetryAfter('/x', {});
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([['missing', {}], ['too long', { 'Retry-After': '3600' }], ['not a number', { 'Retry-After': 'soon' }]])(
    'does not wait when Retry-After is %s',
    async (_name, headers) => {
      fetchMock.mockResolvedValue(response(429, {}, headers));
      const onBusy = vi.fn();

      const result = await fetchWithRetryAfter('/x', {}, onBusy);

      expect(result.status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onBusy).not.toHaveBeenCalled();
    }
  );
});

describe('evaluateWritingAnswer on a 429', () => {
  it('returns the graded result when the retry succeeds', async () => {
    const graded = { isCorrect: true, score: 90, hasCorrectAccents: true, feedback: 'ok', corrections: {} };
    fetchMock.mockResolvedValueOnce(response(429, {}, { 'Retry-After': '2' })).mockResolvedValueOnce(response(200, graded));

    const pending = evaluateWritingAnswer('q1', 'Bonjour');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await pending).toEqual(graded);
  });

  it('returns null, not a graded zero, when the server is still limiting after the retry', async () => {
    fetchMock.mockResolvedValue(response(429, {}, { 'Retry-After': '2' }));

    const pending = evaluateWritingAnswer('q1', 'Bonjour');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await pending).toBeNull();
  });

  it('still reports a non-429 failure as an ungraded zero with the failure message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(response(500));

    const result = await evaluateWritingAnswer('q1', 'Bonjour');

    expect(result).toMatchObject({ isCorrect: false, score: 0 });
  });
});

describe('createStudyCode on a 429', () => {
  it('retries once after Retry-After and returns the code', async () => {
    vi.stubGlobal('window', {});
    fetchMock
      .mockResolvedValueOnce(response(429, { error: 'busy' }, { 'Retry-After': '3' }))
      .mockResolvedValueOnce(response(200, { code: 'brave purple penguin' }));
    const onBusy = vi.fn();

    const pending = createStudyCode(onBusy);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await pending).toBe('brave purple penguin');
    expect(onBusy).toHaveBeenCalledTimes(1);
  });
});
