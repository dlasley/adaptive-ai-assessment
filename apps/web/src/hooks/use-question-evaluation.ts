/**
 * Custom hook for handling question evaluation
 * Manages evaluation state and submission for any question type
 */

import { useCallback, useState } from 'react';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import { evaluateWritingAnswer } from '@/lib/typed-answer-evaluation';

export interface UseQuestionEvaluationProps {
  onSubmit?: (answer: string, evaluation: EvaluationResult) => void;
}

export function useQuestionEvaluation({ onSubmit }: UseQuestionEvaluationProps = {}) {
  const [userAnswer, setUserAnswer] = useState('');
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);

  const submitAnswer = async (questionId: string) => {
    if (!userAnswer.trim() || isEvaluating) return;

    setIsEvaluating(true);

    try {
      const result = await evaluateWritingAnswer(questionId, userAnswer);

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
  }, []);

  return {
    userAnswer,
    setUserAnswer,
    isEvaluating,
    evaluation,
    submitAnswer,
    resetAnswer,
  };
}
