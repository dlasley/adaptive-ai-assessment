import type { LearningResource } from '@/types';

interface ResourceCardProps {
  resource: LearningResource;
  /** Color scheme variant: 'orange' for practice/weak topics, 'purple' for study guide */
  variant?: 'orange' | 'purple' | 'default';
}

const YouTubeIcon = () => (
  <svg className="w-5 h-5 text-red-600 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
    <path d="M10 0C4.477 0 0 4.477 0 10s4.477 10 10 10 10-4.477 10-10S15.523 0 10 0zm3.5 10.5l-5 3a.5.5 0 01-.75-.433v-6a.5.5 0 01.75-.433l5 3a.5.5 0 010 .866z" />
  </svg>
);

const ExternalLinkIcon = ({ className }: { className?: string }) => (
  <svg className={`w-4 h-4 flex-shrink-0 ${className || ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

const ArticleIcon = () => (
  <svg className="w-5 h-5 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const hoverStyles = {
  orange: 'hover:bg-orange-100 dark:hover:bg-orange-900/30 hover:border-orange-300 dark:hover:border-orange-700',
  purple: 'hover:bg-purple-50 dark:hover:bg-purple-900/30 hover:border-purple-300 dark:hover:border-purple-700',
  default: 'hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:border-indigo-300 dark:hover:border-indigo-700',
};

const linkHoverStyles = {
  orange: 'group-hover:text-orange-700 dark:group-hover:text-orange-300',
  purple: 'group-hover:text-purple-700 dark:group-hover:text-purple-300',
  default: 'group-hover:text-indigo-700 dark:group-hover:text-indigo-300',
};

const iconHoverStyles = {
  orange: 'group-hover:text-orange-600 dark:group-hover:text-orange-400',
  purple: 'group-hover:text-purple-600 dark:group-hover:text-purple-400',
  default: 'group-hover:text-indigo-600 dark:group-hover:text-indigo-400',
};

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // YouTube: show youtu.be/VIDEO_ID
    const videoId = u.searchParams.get('v');
    if (videoId && host.includes('youtube')) return `youtu.be/${videoId}`;
    const shortsMatch = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    if (shortsMatch) return `youtu.be/${shortsMatch[1]}`;
    // Other: show domain + truncated path
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${host}${path}`.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}

export default function ResourceCard({ resource, variant = 'default' }: ResourceCardProps) {
  const isVideo = resource.resource_type === 'video';
  const isShort = Boolean(resource.metadata && (resource.metadata as Record<string, unknown>).isShort);

  return (
    <a
      href={resource.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-start gap-3 p-3 bg-white dark:bg-gray-800 rounded-lg transition-colors group border border-transparent ${hoverStyles[variant]}`}
    >
      {isVideo ? <YouTubeIcon /> : <ArticleIcon />}
      <div className="flex-1 min-w-0">
        <h5 className={`font-medium text-sm text-gray-900 dark:text-white ${linkHoverStyles[variant]}`}>
          {resource.title}
        </h5>
        <p className="text-xs italic text-gray-400 dark:text-gray-500 truncate">
          {shortUrl(resource.url)}
        </p>
        <div className="flex items-center gap-2 mt-1">
          {isShort && (
            <span className="px-1.5 py-0.5 text-xs font-semibold rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
              Short
            </span>
          )}
          {resource.difficulty && (
            <span className="px-1.5 py-0.5 text-xs font-semibold rounded bg-gray-100 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
              {resource.difficulty}
            </span>
          )}
        </div>
      </div>
      <ExternalLinkIcon className={`text-gray-400 ${iconHoverStyles[variant]} mt-0.5`} />
    </a>
  );
}
