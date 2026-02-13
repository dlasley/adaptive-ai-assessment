/**
 * AnswerInput - Text input with submit button
 * Supports both single-line (fill-in-blank) and multi-line (writing) variants
 */

import { useState, useEffect } from 'react';
import { isHintDismissed, dismissHint } from '@/lib/onboarding';

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
  const [showKeyboardTip, setShowKeyboardTip] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768 && !isHintDismissed('keyboard_french')) {
      setShowKeyboardTip(true);
    }
  }, []);

  const handleDismissKeyboardTip = () => {
    dismissHint('keyboard_french');
    setShowKeyboardTip(false);
  };

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

      {showKeyboardTip && (
        <div className="mb-2 p-2 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-800 dark:text-blue-200 flex items-start gap-2">
          <span className="shrink-0">{'\uD83C\uDF10'}</span>
          <div className="flex-1">
            <span>Switch your keyboard to French to avoid auto-correct! Tap the </span>
            <span className="font-semibold">{'\uD83C\uDF10'} globe icon</span>
            <span> and select </span>
            <span className="font-semibold">Fran{'\u00E7'}ais</span>
            <span>.</span>
          </div>
          <button
            onClick={handleDismissKeyboardTip}
            className="shrink-0 text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200 font-bold"
            aria-label="Dismiss keyboard tip"
          >
            {'\u2715'}
          </button>
        </div>
      )}

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
