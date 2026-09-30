import type { Question } from '@adaptive/shared/types';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import {
  SuperuserEvaluationMetadataPanel,
  SuperuserQuestionMetadataPanel,
} from '@/components/superuser-metadata-panel';
import {
  buildCommonEvaluationMetadataFields,
  formatQuestionTypeLabel,
  getEvaluationTierLabel,
  type SuperuserMetadataField,
} from '@/lib/superuser-metadata-labels';

type EvaluationMetadata = NonNullable<EvaluationResult['metadata']>;

/**
 * Evaluation-metadata fields for the MCQ/true-false explanation view, which
 * omits Question Type and Difficulty since the Question Metadata panel
 * shown just above it already displays both.
 */
function buildExplanationEvaluationMetadataFields(metadata: EvaluationMetadata): SuperuserMetadataField[] {
  return [
    { label: 'Evaluation Tier', value: getEvaluationTierLabel(metadata.evaluationTier) },
    ...buildCommonEvaluationMetadataFields(metadata),
  ];
}

export interface QuizQuestionViewProps {
  currentQuestion: Question;
  currentQuestionIndex: number;
  questionCount: number;
  userAnswers: Record<string, string>;
  setUserAnswers: (answers: Record<string, string>) => void;
  evaluationResults: Record<string, EvaluationResult>;
  setEvaluationResults: (results: Record<string, EvaluationResult>) => void;
  showExplanation: boolean;
  setShowExplanation: (show: boolean) => void;
  effectiveIsSuperuser: boolean;
  hasAnswered: boolean;
  nextLocked: boolean;
  countdown: number | null;
  handleAnswer: (answer: string) => void;
  handleNextFromExplanation: () => void;
}

/** MCQ / true-false question rendering: options, the revealed explanation, and superuser metadata
 * panels. Writing and fill-in-blank questions render `TypedAnswerQuestion` instead, one level up. */
export function QuizQuestionView({
  currentQuestion,
  currentQuestionIndex,
  questionCount,
  userAnswers,
  setUserAnswers,
  evaluationResults,
  setEvaluationResults,
  showExplanation,
  setShowExplanation,
  effectiveIsSuperuser,
  hasAnswered,
  nextLocked,
  countdown,
  handleAnswer,
  handleNextFromExplanation,
}: QuizQuestionViewProps) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-8">
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <span className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-semibold">
            {currentQuestion.type.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
          </span>
        </div>
        <h3 id="question-heading" tabIndex={-1} className="text-2xl font-bold text-gray-900 dark:text-white mb-6 focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm">
          <span lang="fr">{currentQuestion.question}</span>
        </h3>

        {/* Superuser Metadata - Question Screen */}
        {effectiveIsSuperuser && !showExplanation && (
          <SuperuserQuestionMetadataPanel
            variant="standalone"
            className="mb-4"
            questionTypeLabel={formatQuestionTypeLabel(currentQuestion.type)}
            difficulty={currentQuestion.difficulty}
            topic={currentQuestion.topic}
            topicColSpan
          />
        )}
      </div>

      <div className="space-y-3 mb-8">
        {currentQuestion.options?.map((option, idx) => {
            const isSelected = userAnswers[currentQuestion.id] === option;
            const isCorrect = option === currentQuestion.correctAnswer;
            const showCorrectness = showExplanation;

            return (
              <button
                key={idx}
                onClick={() => handleAnswer(option)}
                className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                  showCorrectness
                    ? isCorrect
                      ? 'border-correct-500 bg-correct-50 dark:bg-correct-900/20'
                      : isSelected
                      ? 'border-incorrect-500 bg-incorrect-50 dark:bg-incorrect-900/20'
                      : 'border-gray-200 dark:border-gray-700'
                    : isSelected
                    ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30'
                    : 'border-gray-200 dark:border-gray-700 hover:border-indigo-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-900 dark:text-white" lang="fr">{option}</span>
                  {showCorrectness && isCorrect && (
                    <span className="text-2xl" aria-hidden="true">✅</span>
                  )}
                  {showCorrectness && isCorrect && (
                    <span className="sr-only">Correct answer</span>
                  )}
                  {showCorrectness && !isCorrect && isSelected && (
                    <span className="text-2xl" aria-hidden="true">❌</span>
                  )}
                  {showCorrectness && !isCorrect && isSelected && (
                    <span className="sr-only">Your incorrect answer</span>
                  )}
                </div>
              </button>
            );
          })}
      </div>

      {showExplanation && (
        <div id="feedback-region" tabIndex={-1} className="mb-6 space-y-4 rounded-lg focus-visible:ring-2 focus-visible:ring-indigo-500">
          <div className={`p-4 rounded-lg border-2 ${
            userAnswers[currentQuestion.id] === currentQuestion.correctAnswer
              ? 'border-correct-500 bg-correct-50 dark:bg-correct-900/20'
              : 'border-incorrect-500 bg-incorrect-50 dark:bg-incorrect-900/20'
          }`}>
            <p className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
              {userAnswers[currentQuestion.id] === currentQuestion.correctAnswer ? (
                <span className="text-correct-700 dark:text-correct-400">✅ Correct!</span>
              ) : (
                <span className="text-incorrect-700 dark:text-incorrect-400">❌ Incorrect</span>
              )}
            </p>
            {userAnswers[currentQuestion.id] !== currentQuestion.correctAnswer && (
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
                Correct answer: <span className="font-semibold text-correct-700 dark:text-correct-400" lang="fr">{currentQuestion.correctAnswer}</span>
              </p>
            )}
          </div>

          {currentQuestion.explanation && (
            <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <p className="text-sm font-semibold text-blue-900 dark:text-blue-300 mb-1">
                Explanation:
              </p>
              <p className="text-blue-800 dark:text-blue-200">{currentQuestion.explanation}</p>
            </div>
          )}

          {/* Superuser Question Metadata for Non-Writing Questions */}
          {effectiveIsSuperuser && (
            <SuperuserQuestionMetadataPanel
              variant="standalone"
              className="mb-4"
              questionTypeLabel={formatQuestionTypeLabel(currentQuestion.type)}
              difficulty={currentQuestion.difficulty}
              topic={currentQuestion.topic}
              topicColSpan
            />
          )}

          {/* Superuser Evaluation Metadata for Non-Writing Questions */}
          {effectiveIsSuperuser && evaluationResults[currentQuestion.id]?.metadata && (
            <SuperuserEvaluationMetadataPanel
              variant="standalone"
              fields={buildExplanationEvaluationMetadataFields(
                evaluationResults[currentQuestion.id].metadata!
              )}
            />
          )}
        </div>
      )}

      <div>
        {!showExplanation && hasAnswered && (
          <button
            onClick={() => setShowExplanation(true)}
            className="w-full py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
          >
            Submit Answer
          </button>
        )}

        {showExplanation && (
          <div className="space-y-3">
            {effectiveIsSuperuser && (
              <button
                onClick={() => {
                  // Clear the answer and evaluation for this question
                  const newAnswers = { ...userAnswers };
                  delete newAnswers[currentQuestion.id];
                  setUserAnswers(newAnswers);

                  const newEvaluations = { ...evaluationResults };
                  delete newEvaluations[currentQuestion.id];
                  setEvaluationResults(newEvaluations);

                  setShowExplanation(false);
                }}
                className="w-full py-3 bg-gray-600 text-white rounded-lg font-semibold hover:bg-gray-700 transition-colors"
              >
                Try Another Answer
              </button>
            )}
            <button
              onClick={handleNextFromExplanation}
              disabled={nextLocked}
              className="w-full py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-indigo-400 disabled:cursor-not-allowed transition-colors"
            >
              {currentQuestionIndex === questionCount - 1 ? 'Finish Quiz' : 'Next Question →'}
              {countdown !== null && ` (${countdown}s)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
