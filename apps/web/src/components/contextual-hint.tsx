'use client';

import { isHintDismissed, dismissHint } from '@/lib/onboarding';
import { useLocalStorageValue, notifyLocalStorageWrite } from '@/hooks/use-local-storage-value';

interface ContextualHintProps {
  id: string;
  message: string;
  position?: 'above' | 'below' | 'inline';
  children?: React.ReactNode;
}

export default function ContextualHint({
  id,
  message,
  position = 'below',
  children,
}: ContextualHintProps) {
  const visible = useLocalStorageValue(
    () => !isHintDismissed(id),
    () => false
  );

  const handleDismiss = () => {
    dismissHint(id);
    notifyLocalStorageWrite();
  };

  if (!visible) return <>{children}</>;

  const hintBanner = (
    <div className="relative bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 rounded-lg px-4 py-3 text-sm text-indigo-800 dark:text-indigo-200 flex items-start gap-2">
      <span className="text-indigo-500 shrink-0 mt-0.5">&#128161;</span>
      <span className="flex-1">{message}</span>
      <button
        onClick={handleDismiss}
        className="text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 shrink-0"
        aria-label="Dismiss hint"
      >
        &#10005;
      </button>
    </div>
  );

  if (position === 'inline') return hintBanner;

  return (
    <div className="space-y-2">
      {position === 'above' && hintBanner}
      {children}
      {position === 'below' && hintBanner}
    </div>
  );
}
