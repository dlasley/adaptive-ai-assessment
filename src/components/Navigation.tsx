'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FEATURES } from '@/lib/feature-flags';

export default function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-6">
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

      {FEATURES.PROGRESS_TRACKING && (
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
      )}

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
    </nav>
  );
}
