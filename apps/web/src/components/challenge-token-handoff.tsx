'use client';

import { useCallback, useRef, useState } from 'react';
import { TurnstileWidget } from '@/components/turnstile-widget';
import { TURNSTILE_VERIFY_CODE_ACTION } from '@/lib/turnstile-constants';

declare global {
  interface Window {
    /** Injected by react-native-webview when this page runs inside the native app. */
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
  }
}

type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * Runs the verify-code Turnstile challenge and hands the token to whoever opened the page. Inside
 * the native app's WebView the first token goes to the host over the bridge and nothing else is
 * shown; in a browser the token is displayed with a copy button.
 */
export function ChallengeTokenHandoff({ siteKey }: { siteKey: string }) {
  // The host app consumes one token and closes the page, so a token from a later re-challenge
  // (after expiry) is never posted.
  const postedRef = useRef(false);
  const [posted, setPosted] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');

  const handleVerify = useCallback((nextToken: string) => {
    const bridge = window.ReactNativeWebView;
    if (bridge) {
      if (postedRef.current) return;
      postedRef.current = true;
      bridge.postMessage(nextToken);
      setPosted(true);
      return;
    }
    setToken(nextToken);
    setCopyStatus('idle');
  }, []);

  // An errored or expired challenge leaves no usable token, so a displayed one is withdrawn.
  const handleError = useCallback(() => {
    setToken(null);
  }, []);

  const handleCopy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  if (posted) {
    return (
      <p aria-live="polite" className="text-sm text-gray-700 dark:text-gray-300">
        Verification complete.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <TurnstileWidget
        siteKey={siteKey}
        action={TURNSTILE_VERIFY_CODE_ACTION}
        onVerify={handleVerify}
        onError={handleError}
      />
      {token && (
        <div className="space-y-2">
          <label
            htmlFor="challenge-token"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Paste this token as turnstileToken in a verify-code request. It works once and expires
            in five minutes.
          </label>
          <div className="flex gap-2">
            <input
              id="challenge-token"
              type="text"
              readOnly
              value={token}
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Copy
            </button>
          </div>
          <p aria-live="polite" className="text-xs text-gray-600 dark:text-gray-400">
            {copyStatus === 'copied' && 'Copied.'}
            {copyStatus === 'failed' && 'Copy failed. Select the token and copy it by hand.'}
          </p>
        </div>
      )}
    </div>
  );
}
