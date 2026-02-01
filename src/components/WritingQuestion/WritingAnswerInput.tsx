/**
 * WritingAnswerInput - Answer textarea and submit button
 */

import type { WritingQuestion } from '@/lib/writing-questions';

interface WritingAnswerInputProps {
  question: WritingQuestion;
  userAnswer: string;
  onAnswerChange: (answer: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  isEvaluating: boolean;
}

export function WritingAnswerInput({
  question,
  userAnswer,
  onAnswerChange,
  onSubmit,
  disabled,
  isEvaluating
}: WritingAnswerInputProps) {
  const handleKeyPress = (e: React.KeyboardEvent) => {
    // Submit on Enter (but allow Shift+Enter for newlines)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div>
      <label htmlFor="answer" className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
        Your Answer (in French):
      </label>
      <textarea
        id="answer"
        value={userAnswer}
        onChange={(e) => onAnswerChange(e.target.value)}
        onKeyPress={handleKeyPress}
        disabled={disabled || isEvaluating}
        placeholder={question.requires_complete_sentence ?
          "Type your complete sentence in French..." :
          "Type your answer in French..."
        }
        className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white text-lg resize-none"
        rows={question.requires_complete_sentence ? 3 : 2}
      />
      <div className="flex items-center justify-between mt-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Press Enter to submit (Shift+Enter for new line)
        </p>
        <button
          onClick={onSubmit}
          disabled={!userAnswer.trim() || isEvaluating || disabled}
          className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-semibold"
        >
          {isEvaluating ? 'Evaluating...' : 'Submit Answer'}
        </button>
      </div>
    </div>
  );
}
