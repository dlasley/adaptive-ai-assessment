/**
 * AnswerInput - Text input with submit button
 * Supports both single-line (fill-in-blank) and multi-line (writing) variants
 */

interface AnswerInputProps {
  userAnswer: string;
  onAnswerChange: (answer: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  isEvaluating: boolean;
  variant?: 'single-line' | 'multi-line';
  placeholder?: string;
  rows?: number;
  label?: string;
}

export function AnswerInput({
  userAnswer,
  onAnswerChange,
  onSubmit,
  disabled = false,
  isEvaluating,
  variant = 'multi-line',
  placeholder = 'Type your answer in French...',
  rows = 2,
  label = 'Your Answer (in French):'
}: AnswerInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Submit on Enter
    // For multi-line: allow Shift+Enter for newlines
    // For single-line: Enter always submits
    if (e.key === 'Enter') {
      if (variant === 'single-line' || !e.shiftKey) {
        e.preventDefault();
        if (userAnswer.trim() && !isEvaluating && !disabled) {
          onSubmit();
        }
      }
    }
  };

  const inputClassName = "w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white text-lg disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div>
      <label htmlFor="answer" className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
        {label}
      </label>

      {variant === 'single-line' ? (
        <input
          type="text"
          id="answer"
          value={userAnswer}
          onChange={(e) => onAnswerChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isEvaluating}
          placeholder={placeholder}
          className={inputClassName}
        />
      ) : (
        <textarea
          id="answer"
          value={userAnswer}
          onChange={(e) => onAnswerChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isEvaluating}
          placeholder={placeholder}
          className={`${inputClassName} resize-none`}
          rows={rows}
        />
      )}

      <div className="flex items-center justify-between mt-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {variant === 'single-line'
            ? 'Press Enter to submit'
            : 'Press Enter to submit (Shift+Enter for new line)'}
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

// Keep the old name as an alias for backward compatibility during refactoring
export { AnswerInput as WritingAnswerInput };
