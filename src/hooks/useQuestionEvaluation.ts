/**
 * Custom hook for handling question evaluation
 * Manages evaluation state and submission for any question type
 */

import { useState } from 'react';
import type { EvaluationResult } from '@/app/api/evaluate-writing/route';
import { evaluateWritingAnswer } from '@/lib/writing-questions';

export interface UseQuestionEvaluationProps {
  onSubmit?: (answer: string, evaluation: EvaluationResult) => void;
}

export function useQuestionEvaluation({ onSubmit }: UseQuestionEvaluationProps = {}) {
  const [userAnswer, setUserAnswer] = useState('');
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);

  const submitAnswer = async (
    question: string,
    correctAnswer: string | null,
    questionType: string,
    difficulty: string,
    acceptableVariations: string[] = [],
    studyCodeId?: string,
    superuserOverride?: boolean | null
  ) => {
    if (!userAnswer.trim() || isEvaluating) return;

    setIsEvaluating(true);

    try {
      const result = await evaluateWritingAnswer(
        question,
        userAnswer,
        correctAnswer,
        questionType,
        difficulty,
        acceptableVariations,
        studyCodeId,
        superuserOverride
      );

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

  const resetAnswer = () => {
    setUserAnswer('');
    setEvaluation(null);
  };

  return {
    userAnswer,
    setUserAnswer,
    isEvaluating,
    evaluation,
    submitAnswer,
    resetAnswer,
  };
}
