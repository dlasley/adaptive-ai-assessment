/**
 * WritingEvaluationResult - Displays evaluation results and feedback
 */

import type { EvaluationResult } from '@/app/api/evaluate-writing/route';
import { highlightDifferences } from './highlightDifferences';

interface WritingEvaluationResultProps {
  evaluation: EvaluationResult;
  userAnswer: string;
  onTryAgain: () => void;
  isSuperuser?: boolean;
  difficulty?: string;
  topic?: string;
  questionType?: string;
}

export function WritingEvaluationResult({
  evaluation,
  userAnswer,
  onTryAgain,
  isSuperuser = false,
  difficulty,
  topic,
  questionType
}: WritingEvaluationResultProps) {
  return (
    <div className={`rounded-xl p-6 ${
      evaluation.isCorrect
        ? 'bg-green-50 dark:bg-green-900/20 border-2 border-green-200 dark:border-green-800'
        : 'bg-red-50 dark:bg-red-900/20 border-2 border-red-200 dark:border-red-800'
    }`}>
      {/* Score and Status */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-4xl">
            {evaluation.isCorrect ? '✅' : '❌'}
          </span>
          <div>
            <h4 className={`text-xl font-bold ${
              evaluation.isCorrect ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'
            }`}>
              {evaluation.isCorrect ? 'Correct!' : 'Not Quite Right'}
            </h4>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Score: {evaluation.score}/100
            </p>
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
        <p className="text-lg font-mono bg-white dark:bg-gray-800 p-3 rounded-lg">
          {userAnswer}
        </p>
      </div>

      {/* Corrected Answer */}
      {evaluation.correctedAnswer && evaluation.correctedAnswer !== userAnswer && (
        <div className="mb-4">
          <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
            Corrected Answer:
          </h5>
          <p className="text-lg font-mono bg-green-100 dark:bg-green-900/30 p-3 rounded-lg text-green-900 dark:text-green-100">
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
        <div className="mt-6 pt-6 border-t border-gray-300 dark:border-gray-600">
          <h5 className="text-sm font-semibold text-purple-700 dark:text-purple-300 mb-3 flex items-center gap-2">
            <span className="text-lg">🔬</span>
            Question Metadata (Superuser)
          </h5>
          <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
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
                  {questionType?.replace(/_/g, ' ') || 'N/A'}
                </span>
              </div>
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Difficulty:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                  {difficulty || 'N/A'}
                </span>
              </div>
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Topic:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300">
                  {topic || 'N/A'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Superuser Evaluation Metadata */}
      {evaluation.metadata && (
        <div className="mt-6 pt-6 border-t border-gray-300 dark:border-gray-600">
          <h5 className="text-sm font-semibold text-purple-700 dark:text-purple-300 mb-3 flex items-center gap-2">
            <span className="text-lg">🔬</span>
            Evaluation Metadata (Superuser)
          </h5>
          <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4 space-y-2">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Difficulty:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">{evaluation.metadata.difficulty}</span>
              </div>
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Evaluation Tier:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300">
                  {evaluation.metadata.evaluationTier.replace(/_/g, ' ')}
                </span>
              </div>
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Similarity:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300">
                  {evaluation.metadata.similarityScore !== undefined ? `${evaluation.metadata.similarityScore}%` : 'N/A'}
                </span>
              </div>
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Confidence:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300">
                  {evaluation.metadata.confidenceScore !== undefined ? `${evaluation.metadata.confidenceScore}%` : 'N/A'}
                </span>
              </div>
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Similarity Threshold:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300">
                  {evaluation.metadata.confidenceThreshold !== undefined ? `${evaluation.metadata.confidenceThreshold}%` : 'N/A'}
                </span>
              </div>
              <div>
                <span className="font-semibold text-purple-900 dark:text-purple-200">Used Claude API:</span>
                <span className="ml-2 text-purple-800 dark:text-purple-300">
                  {evaluation.metadata.usedClaudeAPI ? 'Yes' : 'No'}
                </span>
              </div>
              {evaluation.metadata.modelUsed && (
                <div className="col-span-2">
                  <span className="font-semibold text-purple-900 dark:text-purple-200">Model:</span>
                  <span className="ml-2 text-purple-800 dark:text-purple-300 font-mono text-xs">
                    {evaluation.metadata.modelUsed}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Try Again Button */}
      <button
        onClick={onTryAgain}
        className="mt-4 w-full py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-semibold"
      >
        Try Another Answer
      </button>
    </div>
  );
}
