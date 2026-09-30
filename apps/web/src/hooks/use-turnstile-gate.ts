import { useCallback, useMemo, useRef, useState } from 'react';
import { verifyStudyCode } from '@/lib/study-codes';
import type { TurnstileWidgetHandle } from '@/components/turnstile-widget';
import { TurnstileTokenBuffer } from '@/lib/turnstile-token-buffer';

export type TurnstileGateOutcome = 'valid' | 'invalid' | 'error';

/**
 * How long verify() waits for a solved token before giving up and
 * returning 'error'. Generous enough for a user to complete an
 * interactive challenge; short enough that a widget that never calls any
 * of its callbacks (blocked script, ad blocker) can't hang the caller
 * indefinitely. The widget's own expired-callback typically fires well
 * before this on an unsolved challenge.
 */
const TOKEN_WAIT_TIMEOUT_MS = 90_000;

/**
 * Wraps verifyStudyCode so callers get a plain outcome even when
 * verify-code's circuit breaker demands a Turnstile challenge first. On a
 * 'turnstile_required' response this reveals the widget, awaits its
 * token through a buffer that can't drop a delivery regardless of
 * timing, retries once with that token, and resets the widget so it has
 * a fresh token ready in the background for the next attempt (tokens are
 * single-use).
 */
export function useTurnstileGate() {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const widgetRef = useRef<TurnstileWidgetHandle>(null);
  // A buffered token that goes stale before anyone consumes it is
  // discarded by the buffer itself (see turnstile-token-buffer.ts), but
  // nothing else would then be re-challenging the widget in the
  // background - without this hook the next wait() would sit idle for
  // the full timeout instead of racing a fresh delivery.
  //
  // Lazily constructed on first render only (the `current === null` guard)
  // rather than passed to useRef() directly, since useRef still evaluates
  // its argument on every render even though it only keeps the first one -
  // that would construct and immediately discard a new buffer (and its
  // reset callback) on every re-render.
  const tokenBufferRef = useRef<TurnstileTokenBuffer | null>(null);
  if (tokenBufferRef.current === null) {
    // The closure reads widgetRef.current when the buffer later invokes it
    // (on a stale-token discard), not while this initializer runs, but the
    // static ref check can't see through that deferral.
    // eslint-disable-next-line react-hooks/refs -- deferred read inside a stored callback, not during render
    tokenBufferRef.current = new TurnstileTokenBuffer(() => widgetRef.current?.reset());
  }

  // handleVerify, handleChallengeError, and verify all run after the first
  // render (they're only reachable from a user interaction or an awaited
  // call), by which point the guard above has always populated the ref.
  const handleVerify = useCallback((token: string) => {
    tokenBufferRef.current!.deliver(token);
  }, []);

  const handleChallengeError = useCallback(() => {
    tokenBufferRef.current!.reject();
  }, []);

  const verify = useCallback(async (code: string): Promise<TurnstileGateOutcome> => {
    let result = await verifyStudyCode(code);

    if (result.status === 'turnstile_required') {
      setSiteKey(result.siteKey);
      const token = await tokenBufferRef.current!.wait(TOKEN_WAIT_TIMEOUT_MS);
      if (!token) return 'error';
      widgetRef.current?.reset();
      result = await verifyStudyCode(code, token);
    }

    if (result.status === 'turnstile_required') {
      // Solved once but still rejected - fail rather than loop forever.
      return 'error';
    }

    return result.status;
  }, []);

  // widgetRef is returned outside the memoized object below: a ref mixed
  // into an otherwise plain-data object makes every property access on
  // that object look like a render-time ref read to React Compiler's
  // static analysis, even for properties that aren't the ref itself.
  //
  // `gate` is memoized so its identity is stable across renders that
  // don't change siteKey - it changes only when the circuit breaker first
  // demands a challenge, not on every render of whatever component holds
  // this hook. Callers can safely depend on the whole object (e.g. in a
  // useEffect dependency array) without an incidental re-run on every
  // unrelated state change in that component.
  const gate = useMemo(
    () => ({ verify, siteKey, handleVerify, handleChallengeError }),
    [verify, siteKey, handleVerify, handleChallengeError]
  );

  return { widgetRef, gate };
}
