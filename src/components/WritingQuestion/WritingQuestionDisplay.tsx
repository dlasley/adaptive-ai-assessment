/**
 * QuestionDisplay - Displays question header, metadata, and explanation
 * Works with the unified Question type for both fill-in-blank and writing questions
 */

import type { Question } from '@/types';

interface QuestionDisplayProps {
  question: Question;
  showEvaluation: boolean;
}

export function QuestionDisplay({ question, showEvaluation }: QuestionDisplayProps) {
  // Format question type for display
  const questionTypeLabel = question.type === 'fill-in-blank'
    ? 'Fill in Blank'
    : question.writingType
      ? question.writingType.replace(/_/g, ' ')
      : 'Writing';

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 pb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
            question.difficulty === 'beginner' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
            question.difficulty === 'intermediate' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' :
            'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
          }`}>
            {question.difficulty.charAt(0).toUpperCase() + question.difficulty.slice(1)}
          </span>
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
            {question.topic.replace(/_/g, ' ')}
          </span>
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200 capitalize">
            {questionTypeLabel}
          </span>
        </div>
        {question.requiresCompleteSentence && (
          <span className="text-xs text-gray-600 dark:text-gray-400 italic">
            Complete sentence required
          </span>
        )}
      </div>
      <h3 className="text-xl font-bold text-gray-900 dark:text-white">
        {question.question}
      </h3>
      {question.explanation && !showEvaluation && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
          {question.explanation}
        </p>
      )}
    </div>
  );
}

// Backward compatibility alias
export { QuestionDisplay as WritingQuestionDisplay };
