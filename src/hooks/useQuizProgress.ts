/**
 * Custom hook for managing quiz progress and navigation
 * Reusable for any quiz type (writing, multiple choice, etc.)
 */

import { useState } from 'react';
import type { EvaluationResult } from '@/app/api/evaluate-writing/route';

export interface QuizResult {
  question: string;
  answer: string;
  evaluation: EvaluationResult;
}

export interface QuizStats {
  averageScore: number;
  correctCount: number;
  accentAccuracy: number;
  totalQuestions: number;
}

export function useQuizProgress<T>(questions: T[]) {
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [results, setResults] = useState<QuizResult[]>([]);
  const [showResults, setShowResults] = useState(false);

  const handleSubmit = (answer: string, evaluation: EvaluationResult, questionText: string) => {
    setResults([...results, {
      question: questionText,
      answer,
      evaluation
    }]);
  };

  const nextQuestion = () => {
    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion(currentQuestion + 1);
    } else {
      setShowResults(true);
    }
  };

  const restart = () => {
    setCurrentQuestion(0);
    setResults([]);
    setShowResults(false);
  };

  const calculateStats = (): QuizStats => {
    const averageScore = results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.evaluation.score, 0) / results.length)
      : 0;

    const correctCount = results.filter(r => r.evaluation.isCorrect).length;
    const accentAccuracy = results.filter(r => r.evaluation.hasCorrectAccents).length;

    return {
      averageScore,
      correctCount,
      accentAccuracy,
      totalQuestions: results.length
    };
  };

  const progress = {
    current: currentQuestion + 1,
    total: questions.length,
    percentage: ((currentQuestion + 1) / questions.length) * 100
  };

  return {
    currentQuestion,
    results,
    showResults,
    handleSubmit,
    nextQuestion,
    restart,
    calculateStats,
    progress,
    canProceed: results.length > currentQuestion
  };
}
