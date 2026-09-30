'use client';

import { useEffect, useRef } from 'react';

interface MicroRewardToastProps {
  message: string;
  icon: string;
  onDismiss: () => void;
  duration?: number;
}

export default function MicroRewardToast({
  message,
  icon,
  onDismiss,
  duration = 2500,
}: MicroRewardToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onDismiss, duration]);

  return (
    <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:w-auto z-30 animate-slide-in-right">
      <div className="bg-white shadow-xl rounded-xl px-5 py-3 flex items-center gap-3 border border-gray-100">
        <span className="text-2xl">{icon}</span>
        <span className="font-bold text-gray-900 text-sm sm:text-base whitespace-nowrap">
          {message}
        </span>
      </div>
    </div>
  );
}
