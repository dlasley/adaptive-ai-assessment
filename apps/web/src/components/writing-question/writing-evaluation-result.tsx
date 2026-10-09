/**
 * EvaluationResultDisplay - Displays evaluation results and feedback
 * Works with both fill-in-blank and writing question types
 */

import type { Question } from '@adaptive/shared/types';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import { highlightDifferences } from '@/lib/highlight-differences';
import {
  SuperuserEvaluationMetadataPanel,
  SuperuserQuestionMetadataPanel,
} from '@/components/superuser-metadata-panel';
import {
  formatTypedAnswerQuestionTypeLabel,
  getEvaluationTierLabel,
  getMatchedAgainstLabel,
  getMatchKindLabel,
  type SuperuserMetadataField,
} from '@/lib/superuser-metadata-labels';

interface EvaluationResultDisplayProps {
  evaluation: EvaluationResult;
  userAnswer: string;
  correctAnswer?: string;
  explanation?: string;
  onTryAgain: () => void;
  isSuperuser?: boolean;
  questionType: Question['type'];
  writingType?: Question['writingType'];
}

export function EvaluationResultDisplay({
  evaluation,
  userAnswer,
  correctAnswer,
  explanation,
  onTryAgain,
  isSuperuser = false,
  questionType,
  writingType
}: EvaluationResultDisplayProps) {
  const questionTypeLabel = formatTypedAnswerQuestionTypeLabel(
    questionType === 'fill-in-blank' ? 'fill-in-blank' : 'writing'
  );

  const writingTypeLabel = writingType
    ? writingType.replace(/_/g, ' ')
    : null;

  const evaluationMetadataFields: SuperuserMetadataField[] = [];
  if (evaluation.metadata) {
    const metadata = evaluation.metadata;
    evaluationMetadataFields.push({ label: 'Difficulty', value: metadata.difficulty, capitalize: true });
    evaluationMetadataFields.push({
      label: 'Evaluation Tier',
      value: getEvaluationTierLabel(metadata.evaluationTier),
    });
    if (metadata.evaluationTier === 'exact_match' || metadata.evaluationTier === 'fuzzy_match') {
      evaluationMetadataFields.push({ label: 'Match Score', value: `${evaluation.score}%` });
    }
    if (metadata.evaluationTier === 'semantic') {
      evaluationMetadataFields.push({ label: 'Semantic Score', value: `${evaluation.score}%` });
    }
    if (metadata.matchKind !== undefined) {
      evaluationMetadataFields.push({ label: 'Match Kind', value: getMatchKindLabel(metadata.matchKind) });
    }
    if (metadata.modelConfidence !== undefined) {
      evaluationMetadataFields.push({
        label: 'Semantic Confidence',
        value: `${metadata.modelConfidence}%`,
      });
    }
    evaluationMetadataFields.push({
      label: 'Matched Against',
      value: getMatchedAgainstLabel(metadata.matchedAgainst, metadata.matchedVariationIndex),
    });
    if (metadata.modelUsed) {
      evaluationMetadataFields.push({ label: 'Model', value: metadata.modelUsed, mono: true, fullWidth: true });
    }
    if (metadata.evaluationReason) {
      evaluationMetadataFields.push({
        label: 'Evaluation Reason',
        value: metadata.evaluationReason,
        fullWidth: true,
      });
    }
  }
  return (
    <div
      id="feedback-region"
      tabIndex={-1}
      className={`rounded-xl p-6 focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        evaluation.isCorrect
          ? 'bg-correct-50 dark:bg-correct-900/20 border-2 border-correct-200 dark:border-correct-800'
          : 'bg-incorrect-50 dark:bg-incorrect-900/20 border-2 border-incorrect-200 dark:border-incorrect-800'
      }`}
    >
      {/* Score and Status */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-4xl">
            {evaluation.isCorrect ? '✅' : '❌'}
          </span>
          <div>
            <h4 className={`text-xl font-bold ${
              evaluation.isCorrect ? 'text-correct-800 dark:text-correct-200' : 'text-incorrect-800 dark:text-incorrect-200'
            }`}>
              {evaluation.isCorrect ? 'Correct!' : 'Not Quite Right'}
            </h4>
          </div>
        </div>

        {/* Accent Indicator */}
        <div className="text-right">
          {evaluation.hasCorrectAccents !== null && (
            <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm font-semibold ${
              evaluation.hasCorrectAccents
                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
            }`}>
              {evaluation.hasCorrectAccents ? '✓ Perfect accents' : '⚠️ Check accents'}
            </div>
          )}
        </div>
      </div>

      {/* Your Answer */}
      <div className="mb-4">
        <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
          Your Answer:
        </h5>
        <p className="text-lg font-mono bg-white dark:bg-gray-800 p-3 rounded-lg" lang="fr">
          {userAnswer}
        </p>
      </div>

      {/* Corrected Answer */}
      {evaluation.correctedAnswer && evaluation.correctedAnswer !== userAnswer && (
        <div className="mb-4">
          <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
            Corrected Answer:
          </h5>
          <p className="text-lg font-mono bg-correct-100 dark:bg-correct-900/30 p-3 rounded-lg text-correct-900 dark:text-correct-100" lang="fr">
            {highlightDifferences(userAnswer, evaluation.correctedAnswer)}
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 italic">
            Highlighted words show corrections
          </p>
        </div>
      )}

      {/* Feedback */}
      <div className="mb-4">
        <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
          Feedback:
        </h5>
        <p className="text-gray-800 dark:text-gray-200">
          {evaluation.feedback}
        </p>
      </div>

      {/* Explanation (if provided) */}
      {explanation && (
        <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <h5 className="text-sm font-semibold text-blue-900 dark:text-blue-300 mb-1">
            Explanation:
          </h5>
          <p className="text-blue-800 dark:text-blue-200">{explanation}</p>
        </div>
      )}

      {/* Corrections */}
      {evaluation.corrections && Object.keys(evaluation.corrections).length > 0 && (
        <div className="space-y-2">
          {evaluation.corrections.grammar && evaluation.corrections.grammar.length > 0 && (
            <div>
              <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Grammar:
              </h5>
              <ul className="list-disc list-inside space-y-1">
                {evaluation.corrections.grammar.map((item: string, index: number) => (
                  <li key={index} className="text-sm text-gray-700 dark:text-gray-300">{item}</li>
                ))}
              </ul>
            </div>
          )}

          {evaluation.corrections.accents && evaluation.corrections.accents.length > 0 && (
            <div>
              <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Accents:
              </h5>
              <ul className="list-disc list-inside space-y-1">
                {evaluation.corrections.accents.map((item: string, index: number) => (
                  <li key={index} className="text-sm text-gray-700 dark:text-gray-300">{item}</li>
                ))}
              </ul>
            </div>
          )}

          {evaluation.corrections.suggestions && evaluation.corrections.suggestions.length > 0 && (
            <div>
              <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Suggestions:
              </h5>
              <ul className="list-disc list-inside space-y-1">
                {evaluation.corrections.suggestions.map((item: string, index: number) => (
                  <li key={index} className="text-sm text-gray-700 dark:text-gray-300">{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Superuser Question Metadata */}
      {isSuperuser && (
        <SuperuserQuestionMetadataPanel
          variant="divider"
          spacing="lg"
          questionTypeLabel={questionTypeLabel}
          writingTypeLabel={writingTypeLabel}
          difficulty={evaluation.metadata?.difficulty || 'N/A'}
        />
      )}

      {/* Superuser Evaluation Metadata */}
      {isSuperuser && evaluation.metadata && (
        <SuperuserEvaluationMetadataPanel
          variant="divider"
          spacing="lg"
          fields={evaluationMetadataFields}
        />
      )}

      {/* Try Again Button - Superuser only */}
      {isSuperuser && (
        <button
          onClick={onTryAgain}
          className="mt-4 w-full py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-semibold"
        >
          Try Another Answer
        </button>
      )}
    </div>
  );
}
