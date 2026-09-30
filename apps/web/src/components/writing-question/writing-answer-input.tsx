/**
 * AnswerInput - Text input with submit button
 * Supports both single-line (fill-in-blank) and multi-line (writing) variants
 */

import { isHintDismissed, dismissHint } from '@/lib/onboarding';
import { useLocalStorageValue, notifyLocalStorageWrite } from '@/hooks/use-local-storage-value';
import { COURSE_CONTENT } from '@adaptive/shared/course';
import { buildInlineKeyboardTip } from '@/lib/course-ui-copy';

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
  placeholder = `Type your answer in ${COURSE_CONTENT.language}...`,
  rows = 2,
  label = `Your Answer (in ${COURSE_CONTENT.language}):`
}: AnswerInputProps) {
  const showKeyboardTip = useLocalStorageValue(
    () => window.innerWidth < 768 && !isHintDismissed('keyboard_french'),
    () => false
  );

  const handleDismissKeyboardTip = () => {
    dismissHint('keyboard_french');
    notifyLocalStorageWrite();
  };

  const keyboardTip = buildInlineKeyboardTip(COURSE_CONTENT.language, COURSE_CONTENT.nativeLanguageName);

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

  const inputClassName = "w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-gray-700 dark:text-white text-lg disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div>
      <label htmlFor="answer" className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
        {label}
      </label>

      {showKeyboardTip && (
        <div className="mb-2 p-2 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-800 dark:text-blue-200 flex items-start gap-2">
          <span className="shrink-0">{'\uD83C\uDF10'}</span>
          <div className="flex-1">
            <span>{keyboardTip.intro}</span>
            <span className="font-semibold">{keyboardTip.globeLabel}</span>
            <span>{keyboardTip.middle}</span>
            <span className="font-semibold">{keyboardTip.languageName}</span>
            <span>{keyboardTip.suffix}</span>
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
          lang="fr"
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
          lang="fr"
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
