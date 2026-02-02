/**
 * TypedAnswerQuestion - Unified component for typed answer questions
 * Supports both fill-in-blank (single-line) and writing (multi-line) questions
 */

'use client';

import { useEffect } from 'react';
import type { Question } from '@/types';
import type { EvaluationResult } from '@/app/api/evaluate-writing/route';
import { useQuestionEvaluation } from '@/hooks/useQuestionEvaluation';

import { QuestionDisplay } from './WritingQuestionDisplay';
import { QuestionHints } from './WritingQuestionHints';
import { AnswerInput } from './WritingAnswerInput';
import { EvaluationResultDisplay } from './WritingEvaluationResult';

interface TypedAnswerQuestionProps {
  question: Question;
  onSubmit?: (answer: string, evaluation: EvaluationResult) => void;
  showHints?: boolean;
  disabled?: boolean;
  isSuperuser?: boolean;
  studyCodeUuid?: string | null;
}

export default function TypedAnswerQuestion({
  question,
  onSubmit,
  showHints = true,
  disabled = false,
  isSuperuser = false,
  studyCodeUuid = null
}: TypedAnswerQuestionProps) {
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

  // Determine input variant based on question type
  const inputVariant = question.type === 'fill-in-blank' ? 'single-line' : 'multi-line';
  const questionType = question.type === 'fill-in-blank' ? 'fill_in_blank' : (question.writingType || 'translation');

  const handleSubmit = async () => {
    if (!userAnswer.trim() || isEvaluating) return;

    await submitAnswer(
      question.question,
      question.correctAnswer,
      questionType,
      question.difficulty,
      question.acceptableVariations || [],
      studyCodeUuid || undefined
    );
  };

  // Determine placeholder text
  const getPlaceholder = () => {
    if (question.type === 'fill-in-blank') {
      const blankCount = (question.question.match(/___+/g) || []).length;
      return blankCount > 1
        ? 'Type words separated by spaces...'
        : 'Type your answer in French...';
    }
    return question.requiresCompleteSentence
      ? 'Type your complete sentence in French...'
      : 'Type your answer in French...';
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
      {/* Question Header */}
      <QuestionDisplay
        question={question}
        showEvaluation={!!evaluation}
      />

      {/* Hints - Only for Superusers */}
      {!evaluation && question.hints && question.hints.length > 0 && (
        <QuestionHints
          hints={question.hints}
          isSuperuser={isSuperuser}
          showHints={showHints}
        />
      )}

      {/* Answer Input */}
      {!evaluation && (
        <AnswerInput
          userAnswer={userAnswer}
          onAnswerChange={setUserAnswer}
          onSubmit={handleSubmit}
          disabled={disabled}
          isEvaluating={isEvaluating}
          variant={inputVariant}
          placeholder={getPlaceholder()}
          rows={question.requiresCompleteSentence ? 3 : 2}
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
                {question.type === 'fill-in-blank' ? 'Fill in Blank' : 'Writing'}
              </span>
            </div>
            {question.type === 'writing' && question.writingType && (
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Writing Type:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                  {question.writingType.replace(/_/g, ' ')}
                </span>
              </div>
            )}
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
        <EvaluationResultDisplay
          evaluation={evaluation}
          userAnswer={userAnswer}
          correctAnswer={question.correctAnswer}
          explanation={question.explanation}
          onTryAgain={resetAnswer}
          isSuperuser={isSuperuser}
          questionType={question.type}
          writingType={question.writingType}
        />
      )}
    </div>
  );
}

// Backward compatibility alias
export { TypedAnswerQuestion as WritingQuestionComponent };
