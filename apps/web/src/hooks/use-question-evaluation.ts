/**
 * Custom hook for handling question evaluation
 * Manages evaluation state and submission for any question type
 */

import { useCallback, useState } from 'react';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import { evaluateWritingAnswer, isRateLimitedEvaluation } from '@/lib/typed-answer-evaluation';
import { describeWait } from '@/lib/retry-after';

export interface UseQuestionEvaluationProps {
  onSubmit?: (answer: string, evaluation: EvaluationResult) => void;
}

const BUSY_MESSAGE = 'The grader is busy. Trying again...';
/** Waits at or above this are a daily limit rather than a burst. */
const LONG_WAIT_SECONDS = 3600;

function rateLimitedMessage(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return 'Too many answers at once. Wait a moment, then submit again.';
  if (retryAfterSeconds >= LONG_WAIT_SECONDS) {
    return `The automatic grader is unavailable for now. Try again in about ${describeWait(retryAfterSeconds)}.`;
  }
  return `Too many answers at once. Wait about ${describeWait(retryAfterSeconds)}, then submit again.`;
}

export function useQuestionEvaluation({ onSubmit }: UseQuestionEvaluationProps = {}) {
  const [userAnswer, setUserAnswer] = useState('');
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submitAnswer = async (questionId: string) => {
    if (!userAnswer.trim() || isEvaluating) return;

    setIsEvaluating(true);
    setNotice(null);

    try {
      const result = await evaluateWritingAnswer(questionId, userAnswer, () => setNotice(BUSY_MESSAGE));

      // A rate-limited result means the server was still limiting after the retry: nothing was
      // graded, so no evaluation is shown and no answer is reported.
      if (isRateLimitedEvaluation(result)) {
        setNotice(rateLimitedMessage(result.retryAfterSeconds));
        return null;
      }

      setNotice(null);
      setEvaluation(result);

      if (onSubmit) {
        onSubmit(userAnswer, result);
      }

      return result;
    } catch (error) {
      console.error('Error evaluating answer:', error);
      return null;
    } finally {
      setIsEvaluating(false);
    }
  };

  // useState setters have stable identity across renders, so this callback
  // never changes identity either; callers can safely depend on it.
  const resetAnswer = useCallback(() => {
    setUserAnswer('');
    setEvaluation(null);
    setNotice(null);
  }, []);

  return {
    userAnswer,
    setUserAnswer,
    isEvaluating,
    evaluation,
    notice,
    submitAnswer,
    resetAnswer,
  };
}
