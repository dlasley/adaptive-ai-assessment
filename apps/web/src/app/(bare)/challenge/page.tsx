import { ChallengeTokenHandoff } from '@/components/challenge-token-handoff';

/**
 * Standalone Turnstile challenge for clients that cannot run the widget themselves. A native app
 * loads it in a WebView and receives the token over the WebView bridge; in a desktop browser the
 * token is shown for pasting into a verify-code request.
 */
export default function ChallengePage() {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Verification</h1>
        {siteKey ? (
          <ChallengeTokenHandoff siteKey={siteKey} />
        ) : (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Verification is not available right now.
          </p>
        )}
      </div>
    </main>
  );
}
