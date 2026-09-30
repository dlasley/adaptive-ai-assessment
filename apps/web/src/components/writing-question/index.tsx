/**
 * TypedAnswerQuestion - Unified component for typed answer questions
 * Supports both fill-in-blank (single-line) and writing (multi-line) questions
 */

'use client';

import { useEffect } from 'react';
import type { Question } from '@adaptive/shared/types';
import { COURSE_CONTENT } from '@adaptive/shared/course';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import { useQuestionEvaluation } from '@/hooks/use-question-evaluation';
import { EVALUATING_ANNOUNCEMENT, getEvaluationAnnouncement } from '@/lib/quiz-announcements';
import LiveRegion from '@/components/live-region';

import { QuestionDisplay } from './writing-question-display';
import { QuestionHints } from './writing-question-hints';
import { AnswerInput } from './writing-answer-input';
import { EvaluationResultDisplay } from './writing-evaluation-result';
import { SuperuserQuestionMetadataPanel } from '@/components/superuser-metadata-panel';
import { formatTypedAnswerQuestionTypeLabel } from '@/lib/superuser-metadata-labels';

interface TypedAnswerQuestionProps {
  question: Question;
  onSubmit?: (answer: string, evaluation: EvaluationResult) => void;
  showHints?: boolean;
  disabled?: boolean;
  isSuperuser?: boolean;
}

export default function TypedAnswerQuestion({
  question,
  onSubmit,
  showHints = true,
  disabled = false,
  isSuperuser = false,
}: TypedAnswerQuestionProps) {
  const effectiveIsSuperuser = isSuperuser;

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
  }, [question.id, resetAnswer]);

  // Move focus to the feedback region once evaluation resolves, so
  // screen-reader users land on the result without extra navigation.
  useEffect(() => {
    if (evaluation) {
      document.getElementById('feedback-region')?.focus();
    }
  }, [evaluation]);

  // isEvaluating and evaluation are set in the same batched update once
  // evaluateWritingAnswer resolves (see useQuestionEvaluation.submitAnswer),
  // so this never announces a stale "Evaluating..." on top of a result.
  const liveMessage = isEvaluating
    ? EVALUATING_ANNOUNCEMENT
    : evaluation
      ? getEvaluationAnnouncement(evaluation.isCorrect)
      : '';

  // Determine input variant based on question type
  const inputVariant = question.type === 'fill-in-blank' ? 'single-line' : 'multi-line';

  const handleSubmit = async () => {
    if (!userAnswer.trim() || isEvaluating) return;

    await submitAnswer(question.id);
  };

  // Determine placeholder text
  const getPlaceholder = () => {
    if (question.type === 'fill-in-blank') {
      const blankCount = (question.question.match(/___+/g) || []).length;
      return blankCount > 1
        ? 'Type answers separated by commas...'
        : `Type your answer in ${COURSE_CONTENT.language}...`;
    }
    return question.hasCompleteSentenceRequirement
      ? `Type your complete sentence in ${COURSE_CONTENT.language}...`
      : `Type your answer in ${COURSE_CONTENT.language}...`;
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 space-y-4">
      <LiveRegion message={liveMessage} />

      {/* Question Header */}
      <QuestionDisplay
        question={question}
        showEvaluation={!!evaluation}
      />

      {/* Hints - Only for Superusers */}
      {!evaluation && question.hints && question.hints.length > 0 && (
        <QuestionHints
          hints={question.hints}
          isSuperuser={effectiveIsSuperuser}
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
          rows={question.hasCompleteSentenceRequirement ? 3 : 2}
        />
      )}

      {/* Superuser Metadata - Question Screen */}
      {effectiveIsSuperuser && !evaluation && (
        <SuperuserQuestionMetadataPanel
          variant="standalone"
          questionTypeLabel={formatTypedAnswerQuestionTypeLabel(question.type === 'fill-in-blank' ? 'fill-in-blank' : 'writing')}
          writingTypeLabel={
            question.type === 'writing' && question.writingType
              ? question.writingType.replace(/_/g, ' ')
              : null
          }
          difficulty={question.difficulty}
          topic={question.topic || 'N/A'}
        />
      )}

      {/* Evaluation Result */}
      {evaluation && (
        <EvaluationResultDisplay
          evaluation={evaluation}
          userAnswer={userAnswer}
          correctAnswer={question.correctAnswer}
          explanation={question.explanation}
          onTryAgain={resetAnswer}
          isSuperuser={effectiveIsSuperuser}
          questionType={question.type}
          writingType={question.writingType}
        />
      )}
    </div>
  );
}
