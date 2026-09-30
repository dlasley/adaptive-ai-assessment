'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          action?: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
        }
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * Auto-reset backoff after error/expired-callback: 1s, 2s, 4s, ... capped
 * at 30s. Stops auto-retrying after MAX_AUTO_RETRIES consecutive
 * failures so a persistent outage doesn't re-challenge indefinitely in
 * the background; a visible "Try again" button takes over from there.
 */
const BASE_RETRY_BACKOFF_MS = 1000;
const MAX_RETRY_BACKOFF_MS = 30_000;
const MAX_AUTO_RETRIES = 3;

function retryBackoffMs(attempt: number): number {
  return Math.min(BASE_RETRY_BACKOFF_MS * 2 ** (attempt - 1), MAX_RETRY_BACKOFF_MS);
}

let scriptLoadPromise: Promise<void> | null = null;

/** Loads the Turnstile script at most once per page, regardless of how many widgets mount. */
function loadTurnstileScript(): Promise<void> {
  if (typeof window !== 'undefined' && window.turnstile) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoadPromise = null;
      reject(new Error('Failed to load the Turnstile script'));
    };
    document.head.appendChild(script);
  });

  return scriptLoadPromise;
}

export interface TurnstileWidgetHandle {
  /** Discards the current token and re-runs the challenge. Required before reusing a widget for a second submission — tokens are single-use. */
  reset: () => void;
}

interface TurnstileWidgetProps {
  siteKey: string;
  action: string;
  onVerify: (token: string) => void;
  onError: () => void;
}

export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ siteKey, action, onVerify, onError }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);
    // Guards containerRef.current.focus() to the widget's first appearance
    // only. The render effect below only re-runs on mount or if siteKey/
    // action change, neither of which happens after the first challenge in
    // practice, so this is defense against a future change reintroducing
    // extra effect runs rather than a fix for a reset()-triggered refire —
    // reset() is an imperative call to the Turnstile API and does not
    // re-run this effect.
    const hasFocusedRef = useRef(false);
    // scriptLoadFailed hides the widget container entirely (no widget was
    // ever created to reset). challengeStatus tracks the solved widget's
    // own lifecycle and never hides the container, since error/expired are
    // recoverable in place via reset().
    const [scriptLoadFailed, setScriptLoadFailed] = useState(false);
    const [challengeStatus, setChallengeStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
    // Consecutive error/expired-callback firings since the last success or
    // manual retry. Drives the backoff delay and the cutover to a manual
    // "Try again" affordance once MAX_AUTO_RETRIES is exceeded.
    const retryCountRef = useRef(0);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [autoRetryExhausted, setAutoRetryExhausted] = useState(false);

    const resetWidget = () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    };

    const handleManualRetry = () => {
      retryCountRef.current = 0;
      setAutoRetryExhausted(false);
      setChallengeStatus('loading');
      resetWidget();
    };

    useImperativeHandle(ref, () => ({
      reset: resetWidget,
    }));

    useEffect(() => {
      let cancelled = false;

      loadTurnstileScript()
        .then(() => {
          if (cancelled || !containerRef.current || !window.turnstile) return;
          const scheduleAutoRetry = () => {
            retryCountRef.current += 1;
            if (retryCountRef.current > MAX_AUTO_RETRIES) {
              setAutoRetryExhausted(true);
              return;
            }
            const delay = retryBackoffMs(retryCountRef.current);
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              resetWidget();
            }, delay);
          };

          widgetIdRef.current = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            action,
            callback: (token) => {
              retryCountRef.current = 0;
              setAutoRetryExhausted(false);
              setChallengeStatus('ready');
              onVerify(token);
            },
            'error-callback': () => {
              setChallengeStatus('failed');
              onError();
              // Cloudflare's widget does not retry on its own after an
              // error; without this the widget is permanently dead. The
              // eventual success callback flips the status back to
              // 'ready' once the re-challenge resolves.
              scheduleAutoRetry();
            },
            'expired-callback': () => {
              setChallengeStatus('failed');
              onError();
              // A solved-but-expired token can't be reused; re-challenge
              // so a fresh token is available for the next attempt.
              scheduleAutoRetry();
            },
          });
          setChallengeStatus('ready');
          if (!hasFocusedRef.current) {
            hasFocusedRef.current = true;
            containerRef.current.focus();
          }
        })
        .catch(() => {
          if (cancelled) return;
          setScriptLoadFailed(true);
          // Nothing else tells the buffer this attempt failed - without
          // this, a caller waiting on wait() sits until the full timeout
          // even though the widget is already showing an error.
          onError();
        });

      return () => {
        cancelled = true;
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }
      };
    }, [siteKey, action, onVerify, onError]);

    const statusMessage =
      challengeStatus === 'loading'
        ? 'Loading verification widget...'
        : challengeStatus === 'failed'
          ? autoRetryExhausted
            ? 'Verification failed repeatedly. Please try again.'
            : 'Verification failed or expired. Please try again.'
          : 'Verification widget ready. Please complete it to continue.';

    return (
      <div className="space-y-2">
        <label
          id="turnstile-widget-label"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Additional verification is required to continue.
        </label>
        {scriptLoadFailed ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Could not load the verification widget. Please refresh the page and try again.
          </p>
        ) : (
          <div ref={containerRef} role="group" aria-labelledby="turnstile-widget-label" tabIndex={-1} />
        )}
        {autoRetryExhausted && !scriptLoadFailed && (
          <button
            type="button"
            onClick={handleManualRetry}
            className="text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            Verification keeps failing. Try again.
          </button>
        )}
        <p aria-live="polite" className="sr-only">
          {statusMessage}
        </p>
      </div>
    );
  }
);
