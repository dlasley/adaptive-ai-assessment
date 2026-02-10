'use client';

interface EmptyStateGuideProps {
  onStartPractice: () => void;
}

export default function EmptyStateGuide({ onStartPractice }: EmptyStateGuideProps) {
  return (
    <div className="space-y-6">
      <div className="text-center py-8 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-gray-800 dark:to-gray-700 rounded-xl border-2 border-dashed border-indigo-300 dark:border-indigo-700">
        <div className="text-6xl mb-4">&#128221;</div>
        <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          No Quizzes Yet
        </h3>
        <p className="text-gray-600 dark:text-gray-300 mb-6 max-w-md mx-auto">
          Take your first quiz to start tracking your progress! Your scores,
          topic mastery, and study recommendations will appear here.
        </p>
        <button
          onClick={onStartPractice}
          className="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium shadow-lg"
        >
          Start Practicing
        </button>
      </div>

      <div className="max-w-4xl mx-auto">
        <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 text-center">
          What you&apos;ll unlock
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-5 text-center shadow-sm border border-gray-200 dark:border-gray-700 opacity-75">
            <div className="text-3xl mb-2">&#128202;</div>
            <h5 className="font-semibold text-gray-900 dark:text-white mb-1">Score Tracking</h5>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              See your accuracy across all quizzes
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-5 text-center shadow-sm border border-gray-200 dark:border-gray-700 opacity-75">
            <div className="text-3xl mb-2">&#127919;</div>
            <h5 className="font-semibold text-gray-900 dark:text-white mb-1">Topic Mastery</h5>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Track strengths and weaknesses by topic
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-5 text-center shadow-sm border border-gray-200 dark:border-gray-700 opacity-75">
            <div className="text-3xl mb-2">&#127916;</div>
            <h5 className="font-semibold text-gray-900 dark:text-white mb-1">Study Recommendations</h5>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Get personalized video suggestions
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
