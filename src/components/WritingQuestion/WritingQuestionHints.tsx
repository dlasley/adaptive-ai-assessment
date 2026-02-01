/**
 * WritingQuestionHints - Displays progressive hints for superusers
 */

import { useState } from 'react';
import type { WritingQuestion } from '@/lib/writing-questions';

interface WritingQuestionHintsProps {
  question: WritingQuestion;
  isSuperuser: boolean;
  showHints: boolean;
}

export function WritingQuestionHints({ question, isSuperuser, showHints }: WritingQuestionHintsProps) {
  const [showHintIndex, setShowHintIndex] = useState(-1);

  if (!showHints || !isSuperuser || !question.hints || question.hints.length === 0) {
    return null;
  }

  return (
    <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-lg p-4 border-2 border-indigo-200 dark:border-indigo-800">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-indigo-900 dark:text-indigo-300 flex items-center gap-2">
          <span>💡 Hints</span>
          <span className="text-xs px-2 py-0.5 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded">
            Superuser
          </span>
        </h4>
        {showHintIndex < question.hints.length - 1 && (
          <button
            onClick={() => setShowHintIndex(showHintIndex + 1)}
            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            Show next hint
          </button>
        )}
      </div>
      {question.hints.slice(0, showHintIndex + 1).map((hint, index) => (
        <p key={index} className="text-sm text-indigo-800 dark:text-indigo-200 mt-2">
          {index + 1}. {hint}
        </p>
      ))}
    </div>
  );
}
