/** Longest server-requested wait the client will sit through before giving up on the retry. */
const MAX_WAIT_SECONDS = 60;

/**
 * Fetches `url`; on a 429 whose Retry-After is within MAX_WAIT_SECONDS, waits that long and
 * retries once. `onBusy` runs just before the wait so the caller can show a "busy" message.
 * Returns the retry's response, or the original 429 when the wait is missing or too long.
 */
export async function fetchWithRetryAfter(
  url: string,
  init: RequestInit,
  onBusy?: () => void,
): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status !== 429) return response;

  const seconds = Number(response.headers.get('Retry-After'));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_WAIT_SECONDS) return response;

  onBusy?.();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return fetch(url, init);
}
