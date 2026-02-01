/**
 * WritingQuestion - Main component composing all sub-components
 * Refactored for better maintainability and reusability
 */

'use client';

import { useEffect, useState } from 'react';
import type { WritingQuestion } from '@/lib/writing-questions';
import type { EvaluationResult } from '@/app/api/evaluate-writing/route';
import { useQuestionEvaluation } from '@/hooks/useQuestionEvaluation';
import { getStoredStudyCode, getStudyCodeId } from '@/lib/study-codes';

import { WritingQuestionDisplay } from './WritingQuestionDisplay';
import { WritingQuestionHints } from './WritingQuestionHints';
import { WritingAnswerInput } from './WritingAnswerInput';
import { WritingEvaluationResult } from './WritingEvaluationResult';

interface WritingQuestionProps {
  question: WritingQuestion;
  onSubmit?: (answer: string, evaluation: EvaluationResult) => void;
  showHints?: boolean;
  disabled?: boolean;
}

export default function WritingQuestionComponent({
  question,
  onSubmit,
  showHints = true,
  disabled = false
}: WritingQuestionProps) {
  const [isSuperuser, setIsSuperuser] = useState(false);

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

  // Check superuser status from evaluation metadata
  useEffect(() => {
    if (evaluation?.metadata) {
      setIsSuperuser(true);
    }
  }, [evaluation]);

  const handleSubmit = async () => {
    if (!userAnswer.trim() || isEvaluating) return;

    // Get study code ID for superuser metadata
    let studyCodeId: string | undefined;
    const code = getStoredStudyCode();
    if (code) {
      const id = await getStudyCodeId(code);
      if (id) studyCodeId = id;
    }

    await submitAnswer(
      question.question_en,
      question.correct_answer_fr,
      question.question_type,
      question.difficulty,
      question.acceptable_variations || [],
      studyCodeId
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

      {/* Evaluation Result */}
      {evaluation && (
        <WritingEvaluationResult
          evaluation={evaluation}
          userAnswer={userAnswer}
          onTryAgain={resetAnswer}
        />
      )}
    </div>
  );
}
