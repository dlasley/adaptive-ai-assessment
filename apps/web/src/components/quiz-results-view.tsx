import type { Question } from '@adaptive/shared/types';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import type { TopicRecommendation } from '@/hooks/use-quiz-session';
import type { MilestoneResult } from '@/lib/milestone-detection';
import LoadingSpinner from '@/components/loading-spinner';
import AnimatedScoreCounter from '@/components/animated-score-counter';
import CelebrationOverlay from '@/components/celebration-overlay';
import MicroRewardToast from '@/components/micro-reward-toast';
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
 * Evaluation-metadata fields for the quiz results view, which shows a
 * combined "Writing (translation)"-style question type for writing
 * questions since there's no separate Question Metadata panel next to it
 * for non-writing types.
 */
function buildResultsEvaluationMetadataFields(
  question: Question,
  metadata: EvaluationMetadata
): SuperuserMetadataField[] {
  return [
    {
      label: 'Question Type',
      value: question.type === 'writing'
        ? `Writing (${question.writingType?.replace(/_/g, ' ')})`
        : formatQuestionTypeLabel(question.type),
    },
    { label: 'Difficulty', value: metadata.difficulty, capitalize: true },
    { label: 'Evaluation Tier', value: getEvaluationTierLabel(metadata.evaluationTier) },
    ...buildCommonEvaluationMetadataFields(metadata),
  ];
}

export interface QuizResultsViewProps {
  score: { correct: number; total: number; percentage: number };
  isAssessmentMode: boolean;
  modeConfig: { label: string };
  topic: string;
  milestones: MilestoneResult | null;
  showOverlay: boolean;
  dismissOverlay: () => void;
  streakToast: { msg: string; icon: string } | null;
  dismissStreakToast: () => void;
  activeResultsTab: 'answers' | 'studyGuide';
  setActiveResultsTab: (tab: 'answers' | 'studyGuide') => void;
  loadingStudyGuide: boolean;
  questions: Question[];
  userAnswers: Record<string, string>;
  evaluationResults: Record<string, EvaluationResult>;
  effectiveIsSuperuser: boolean;
  studyGuide: TopicRecommendation[];
  onPracticeAgain: () => void;
}

/** The post-quiz results screen: score, per-question answer review, and the study guide tab. */
export function QuizResultsView({
  score,
  isAssessmentMode,
  modeConfig,
  topic,
  milestones,
  showOverlay,
  dismissOverlay,
  streakToast,
  dismissStreakToast,
  activeResultsTab,
  setActiveResultsTab,
  loadingStudyGuide,
  questions,
  userAnswers,
  evaluationResults,
  effectiveIsSuperuser,
  studyGuide,
  onPracticeAgain,
}: QuizResultsViewProps) {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-8">
        <div className="text-center mb-8">
          <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full mb-4 ${
            isAssessmentMode
              ? 'bg-assessment-100 dark:bg-assessment-900/30 text-assessment-800 dark:text-assessment-200'
              : 'bg-practice-100 dark:bg-practice-900/30 text-practice-800 dark:text-practice-200'
          }`}>
            <span>{isAssessmentMode ? '📝' : '📚'}</span>
            <span className="font-semibold">{modeConfig.label}</span>
          </div>
          <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            {isAssessmentMode ? 'Assessment Complete!' : 'Quiz Complete! 🎉'}
          </h2>
          <p className="text-gray-600 dark:text-gray-300">{topic}</p>
        </div>

        <div className={`rounded-lg p-8 text-white text-center mb-8 ${
          isAssessmentMode
            ? 'bg-linear-to-r from-amber-500 to-orange-600'
            : 'bg-linear-to-r from-indigo-500 to-purple-600'
        }`}>
          <AnimatedScoreCounter target={score.percentage} className="text-6xl font-bold mb-2" />
          <div className="text-xl">
            {score.correct} out of {score.total} correct
          </div>
          {milestones?.isNewHighScore && (
            <div className="animate-badge-pop mt-3 inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 text-yellow-900 rounded-full font-bold text-lg shadow-lg">
              {milestones.isNewOverallHighScore ? '⭐ All-Time Best!' : '⭐ New Best!'}
            </div>
          )}
          {isAssessmentMode && (
            <div className="mt-2 text-sm opacity-90">
              Written responses only
            </div>
          )}
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6">
          <button
            onClick={() => setActiveResultsTab('answers')}
            className={`flex-1 py-3 px-4 text-sm font-semibold transition-colors ${
              activeResultsTab === 'answers'
                ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            Questions & Answers
          </button>
          <button
            onClick={() => setActiveResultsTab('studyGuide')}
            className={`flex-1 py-3 px-4 text-sm font-semibold transition-colors ${
              activeResultsTab === 'studyGuide'
                ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            Study Guide
            {loadingStudyGuide && (
              <span className="ml-2 inline-block w-4 h-4 border-2 border-gray-300 border-t-indigo-600 rounded-full animate-spin"></span>
            )}
          </button>
        </div>

        {/* Questions & Answers Tab */}
        {activeResultsTab === 'answers' && (
        <div className="space-y-4 mb-8">
          {questions.map((q, idx) => {
            const userAnswer = userAnswers[q.id];
            // For typed-answer questions (writing and fill-in-blank), use evaluation result; for others, direct comparison
            const isCorrect = (q.type === 'writing' || q.type === 'fill-in-blank') && evaluationResults[q.id]
              ? evaluationResults[q.id].isCorrect
              : userAnswer === q.correctAnswer;
            const evaluation = evaluationResults[q.id];

            return (
              <div
                key={q.id}
                className={`p-4 rounded-lg border-2 ${
                  isCorrect
                    ? 'border-correct-500 bg-correct-50 dark:bg-correct-900/20'
                    : 'border-incorrect-500 bg-incorrect-50 dark:bg-incorrect-900/20'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    {idx + 1}. <span lang="fr">{q.question}</span>
                  </h3>
                  <div className="flex items-center gap-2">
                    {q.type === 'writing' && evaluation && (
                      <span className="text-sm font-semibold text-gray-600 dark:text-gray-400">
                        {evaluation.score}%
                      </span>
                    )}
                    <span className="text-2xl" aria-hidden="true">{isCorrect ? '✅' : '❌'}</span>
                    <span className="sr-only">{isCorrect ? 'Correct' : 'Incorrect'}</span>
                  </div>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-1">
                  Your answer: <span className="font-semibold" lang={userAnswer ? 'fr' : undefined}>{userAnswer || 'Not answered'}</span>
                </p>
                {!isCorrect && q.type !== 'writing' && q.type !== 'fill-in-blank' && (
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                    Correct answer: <span className="font-semibold text-correct-700 dark:text-correct-400" lang="fr">{q.correctAnswer}</span>
                  </p>
                )}
                {(q.type === 'writing' || q.type === 'fill-in-blank') && evaluation && (
                  <div className="mt-2 space-y-2">
                    {evaluation.correctedAnswer && (
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        Suggested answer: <span className="font-semibold text-correct-700 dark:text-correct-400" lang="fr">{evaluation.correctedAnswer}</span>
                      </p>
                    )}
                    {evaluation.feedback && (
                      <p className="text-sm text-blue-800 dark:text-blue-200 bg-blue-50 dark:bg-blue-900/20 p-2 rounded-sm">
                        💡 {evaluation.feedback}
                      </p>
                    )}
                  </div>
                )}
                {q.explanation && q.type !== 'writing' && (
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 p-3 rounded-sm mt-2">
                    💡 {q.explanation}
                  </p>
                )}

                {/* Superuser Question Metadata - For writing questions */}
                {effectiveIsSuperuser && q.type === 'writing' && (
                  <SuperuserQuestionMetadataPanel
                    variant="divider"
                    spacing="sm"
                    questionTypeLabel="writing"
                    writingTypeLabel={q.writingType?.replace(/_/g, ' ') || 'N/A'}
                    difficulty={q.difficulty}
                    topic={q.topic || 'N/A'}
                  />
                )}

                {/* Superuser Evaluation Metadata - Show for all question types */}
                {effectiveIsSuperuser && evaluation && evaluation.metadata && (
                  <SuperuserEvaluationMetadataPanel
                    variant="divider"
                    spacing="sm"
                    fields={buildResultsEvaluationMetadataFields(q, evaluation.metadata)}
                  />
                )}
              </div>
            );
          })}
        </div>
        )}

        {/* Study Guide Tab */}
        {activeResultsTab === 'studyGuide' && (
          <div className="mb-8">
            {loadingStudyGuide && (
              <div className="p-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <div className="flex items-center justify-center">
                  <LoadingSpinner size="md" color="blue" className="mr-3" />
                  <p className="text-blue-800 dark:text-blue-200">Generating your personalized study guide...</p>
                </div>
              </div>
            )}

            {!loadingStudyGuide && studyGuide.length > 0 && (
              <>
                <div className="bg-linear-to-r from-purple-500 to-indigo-600 rounded-lg p-6 text-white mb-4">
                  <h3 className="text-2xl font-bold mb-2">Study Guide</h3>
                  <p className="text-purple-100">
                    Based on your results, here are some topics to review:
                  </p>
                </div>

                <div className="space-y-6">
                  {studyGuide.map((recommendation, idx) => (
                    <div
                      key={idx}
                      className="bg-white dark:bg-gray-800 border-2 border-purple-200 dark:border-purple-800 rounded-lg p-6"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-3">
                        <h4 className="text-xl font-bold text-gray-900 dark:text-white">
                          {recommendation.topic}
                        </h4>
                        <span className="px-3 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded-full text-sm font-semibold whitespace-nowrap self-start">
                          {recommendation.count} {recommendation.count === 1 ? 'question' : 'questions'} missed
                        </span>
                      </div>

                      {recommendation.resources.length > 0 ? (
                        <div>
                          <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                            Recommended Videos:
                          </p>
                          <div className="space-y-2">
                            {recommendation.resources.map((resource, resIdx) => (
                              <a
                                key={resIdx}
                                href={resource.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors group"
                              >
                                <svg
                                  className="w-5 h-5 text-red-600 shrink-0"
                                  fill="currentColor"
                                  viewBox="0 0 20 20"
                                >
                                  <path d="M10 0C4.477 0 0 4.477 0 10s4.477 10 10 10 10-4.477 10-10S15.523 0 10 0zm3.5 10.5l-5 3a.5.5 0 01-.75-.433v-6a.5.5 0 01.75-.433l5 3a.5.5 0 010 .866z" />
                                </svg>
                                <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-purple-700 dark:group-hover:text-purple-300 wrap-break-word">
                                  {resource.title || 'Video Resource'}
                                </span>
                                <svg
                                  className="w-4 h-4 ml-auto text-gray-400 group-hover:text-purple-600 shrink-0"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                                  />
                                </svg>
                              </a>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-600 dark:text-gray-400 italic">
                          No video resources available for this topic yet.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {!loadingStudyGuide && studyGuide.length === 0 && score.percentage === 100 && (
              <div className="p-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-center">
                <p className="text-xl font-bold text-green-800 dark:text-green-300">
                  Perfect Score!
                </p>
                <p className="text-green-700 dark:text-green-400 mt-2">
                  You&apos;ve mastered this material. Keep up the excellent work!
                </p>
              </div>
            )}

            {!loadingStudyGuide && studyGuide.length === 0 && score.percentage < 100 && (
              <div className="p-6 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-center">
                <p className="text-gray-600 dark:text-gray-400">
                  No study recommendations available for this quiz.
                </p>
              </div>
            )}
          </div>
        )}

        <button
          onClick={onPracticeAgain}
          className="w-full py-3 px-6 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
        >
          Practice Again
        </button>
      </div>
      {showOverlay && milestones && (
        <CelebrationOverlay milestones={milestones} onDismiss={dismissOverlay} />
      )}
      {streakToast && (
        <MicroRewardToast
          message={streakToast.msg}
          icon={streakToast.icon}
          onDismiss={dismissStreakToast}
        />
      )}
    </div>
  );
}
