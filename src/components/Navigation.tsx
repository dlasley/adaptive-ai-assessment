'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FEATURES } from '@/lib/feature-flags';
import { isSoundEnabled, setSoundEnabled } from '@/lib/celebration-settings';

export default function Navigation() {
  const pathname = usePathname();
  const [soundOn, setSoundOn] = useState(true);

  useEffect(() => {
    setSoundOn(isSoundEnabled());
  }, []);

  const toggleSound = () => {
    const newValue = !soundOn;
    setSoundOn(newValue);
    setSoundEnabled(newValue);
  };

  return (
    <nav className="flex items-center gap-4 sm:gap-6">
      <Link
        href="/"
        className={`text-sm font-medium transition-colors ${
          pathname === '/'
            ? 'text-indigo-600 dark:text-indigo-400'
            : 'text-gray-600 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400'
        }`}
      >
        Home
      </Link>

      <Link
        href="/progress"
        className={`text-sm font-medium transition-colors ${
          pathname === '/progress'
            ? 'text-indigo-600 dark:text-indigo-400'
            : 'text-gray-600 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400'
        }`}
      >
        My Progress
      </Link>

      <Link
        href="/resources"
        className={`text-sm font-medium transition-colors ${
          pathname === '/resources'
            ? 'text-indigo-600 dark:text-indigo-400'
            : 'text-gray-600 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400'
        }`}
      >
        Resources
      </Link>

      {FEATURES.ADMIN_PANEL && (
        <Link
          href="/admin"
          className={`text-sm font-medium transition-colors ${
            pathname === '/admin'
              ? 'text-indigo-600 dark:text-indigo-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400'
          }`}
        >
          Teacher Dashboard
        </Link>
      )}

      <button
        onClick={toggleSound}
        className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-indigo-600 transition-colors"
        aria-label={soundOn ? 'Mute sounds' : 'Unmute sounds'}
        title={soundOn ? 'Mute sounds' : 'Unmute sounds'}
      >
        {soundOn ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        )}
      </button>
    </nav>
  );
}
