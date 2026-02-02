/**
 * WritingQuestion - Main component composing all sub-components
 * Refactored for better maintainability and reusability
 */

'use client';

import { useEffect } from 'react';
import type { WritingQuestion } from '@/lib/writing-questions';
import type { EvaluationResult } from '@/app/api/evaluate-writing/route';
import { useQuestionEvaluation } from '@/hooks/useQuestionEvaluation';

import { WritingQuestionDisplay } from './WritingQuestionDisplay';
import { WritingQuestionHints } from './WritingQuestionHints';
import { WritingAnswerInput } from './WritingAnswerInput';
import { WritingEvaluationResult } from './WritingEvaluationResult';

interface WritingQuestionProps {
  question: WritingQuestion;
  onSubmit?: (answer: string, evaluation: EvaluationResult) => void;
  showHints?: boolean;
  disabled?: boolean;
  isSuperuser?: boolean;
  studyCodeUuid?: string | null;
}

export default function WritingQuestionComponent({
  question,
  onSubmit,
  showHints = true,
  disabled = false,
  isSuperuser = false,
  studyCodeUuid = null
}: WritingQuestionProps) {
  const {
    userAnswer,
    setUserAnswer,
    isEvaluating,
    evaluation,
    submitAnswer,
    resetAnswer
  } = useQuestionEvaluation({ onSubmit });

  // Reset state when question changes
  useEffect(() => {
    resetAnswer();
  }, [question.id]);

  const handleSubmit = async () => {
    if (!userAnswer.trim() || isEvaluating) return;

    await submitAnswer(
      question.question_en,
      question.correct_answer_fr,
      question.question_type,
      question.difficulty,
      question.acceptable_variations || [],
      studyCodeUuid || undefined
    );
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
      {/* Question Header */}
      <WritingQuestionDisplay
        question={question}
        showEvaluation={!!evaluation}
      />

      {/* Hints - Only for Superusers */}
      {!evaluation && (
        <WritingQuestionHints
          question={question}
          isSuperuser={isSuperuser}
          showHints={showHints}
        />
      )}

      {/* Answer Input */}
      {!evaluation && (
        <WritingAnswerInput
          question={question}
          userAnswer={userAnswer}
          onAnswerChange={setUserAnswer}
          onSubmit={handleSubmit}
          disabled={disabled}
          isEvaluating={isEvaluating}
        />
      )}

      {/* Superuser Metadata - Question Screen */}
      {isSuperuser && !evaluation && (
        <div className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg">
          <h5 className="text-sm font-semibold text-purple-900 dark:text-purple-300 mb-2 flex items-center gap-2">
            <span className="text-lg">🔬</span>
            Question Metadata (Superuser)
          </h5>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="font-semibold text-purple-900 dark:text-purple-200">Question Type:</span>
              <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                writing
              </span>
            </div>
            <div>
              <span className="font-semibold text-purple-900 dark:text-purple-200">Writing Type:</span>
              <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                {question.question_type?.replace(/_/g, ' ') || 'N/A'}
              </span>
            </div>
            <div>
              <span className="font-semibold text-purple-900 dark:text-purple-200">Difficulty:</span>
              <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                {question.difficulty}
              </span>
            </div>
            <div>
              <span className="font-semibold text-purple-900 dark:text-purple-200">Topic:</span>
              <span className="ml-2 text-purple-800 dark:text-purple-300">
                {question.topic || 'N/A'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Evaluation Result */}
      {evaluation && (
        <WritingEvaluationResult
          evaluation={evaluation}
          userAnswer={userAnswer}
          onTryAgain={resetAnswer}
          isSuperuser={isSuperuser}
          difficulty={question.difficulty}
          topic={question.topic}
          questionType={question.question_type}
        />
      )}
    </div>
  );
}
