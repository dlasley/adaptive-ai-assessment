'use client';

import { useRouter } from 'next/navigation';
import { COURSE_CONTENT } from '@adaptive/shared/course';
import { buildOnboardingKeyboardTip } from '@/lib/course-ui-copy';
import TypedAnswerQuestion from '@/components/writing-question';
import LoadingSpinner from '@/components/loading-spinner';
import OnboardingTour from '@/components/onboarding-tour';
import { Step } from 'react-joyride';
import MicroRewardToast from '@/components/micro-reward-toast';
import LiveRegion from '@/components/live-region';
import { getEvaluationAnnouncement, getProgressAnnouncement } from '@/lib/quiz-announcements';
import { useQuizSession } from '@/hooks/use-quiz-session';
import { QuizResultsView } from '@/components/quiz-results-view';
import { QuizQuestionView } from '@/components/quiz-question-view';

export default function QuizPage() {
  const router = useRouter();
  const session = useQuizSession();
  const {
    unitId, topic, difficulty, adaptive, unit, displayTitle, modeConfig, isAssessmentMode,
    questions, currentQuestionIndex, userAnswers, setUserAnswers, evaluationResults, setEvaluationResults,
    loading, error, warnings,
    showResults, showExplanation, setShowExplanation,
    studyGuide, loadingStudyGuide,
    activeResultsTab, setActiveResultsTab,
    countdown,
    effectiveIsSuperuser,
    runQuizTour, setRunQuizTour, completeQuizTour,
    milestones, showOverlay, streakToast, dismissOverlay, dismissStreakToast,
    currentQuestion, hasAnswered, nextLocked, calculateScore,
    handleAnswer, handleTypedAnswerSubmit, handleNextFromExplanation,
  } = session;

  const quizTourSteps: Step[] = [
    {
      target: '#tour-quiz-mode-badge',
      content: 'This shows your current quiz mode.',
      skipBeacon: true,
    },
    {
      target: '#tour-quiz-counter',
      content: 'Track your progress through the quiz here.',
    },
    {
      target: '#tour-quiz-answer-area',
      content: 'Type or select your answer here. For written questions, don\'t forget to press and hold letters (e) to select correct accents (é)',
    },
    ...(typeof window !== 'undefined' && window.innerWidth < 768 ? [{
      target: '#tour-quiz-answer-area',
      content: buildOnboardingKeyboardTip(
        COURSE_CONTENT.language,
        COURSE_CONTENT.nativeLanguageName,
        COURSE_CONTENT.specialCharacters
      ),
    }] : []),
    {
      target: '#tour-quiz-progress',
      content: 'This bar shows how far along you are. Keep going!',
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <LoadingSpinner className="mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-300">
            Generating your personalized quiz questions...
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
        <h2 className="text-xl font-bold text-red-800 dark:text-red-300 mb-2">
          Error Loading Quiz
        </h2>
        <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
        <button
          onClick={() => router.back()}
          className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
        >
          Go Back
        </button>
      </div>
    );
  }

  if (showResults) {
    return (
      <QuizResultsView
        score={calculateScore()}
        isAssessmentMode={isAssessmentMode}
        modeConfig={modeConfig}
        topic={topic}
        milestones={milestones}
        showOverlay={showOverlay}
        dismissOverlay={dismissOverlay}
        streakToast={streakToast}
        dismissStreakToast={dismissStreakToast}
        activeResultsTab={activeResultsTab}
        setActiveResultsTab={setActiveResultsTab}
        loadingStudyGuide={loadingStudyGuide}
        questions={questions}
        userAnswers={userAnswers}
        evaluationResults={evaluationResults}
        effectiveIsSuperuser={effectiveIsSuperuser}
        studyGuide={studyGuide}
        onPracticeAgain={() => router.push('/')}
      />
    );
  }

  if (!currentQuestion) {
    return null;
  }

  // MCQ/true-false questions announce their evaluation result once the
  // explanation is revealed; otherwise (including while an explanation is
  // showing for a typed-answer question, which announces its own result
  // inside TypedAnswerQuestion) the region reports quiz progress.
  const isTypedAnswerQuestion = currentQuestion.type === 'writing' || currentQuestion.type === 'fill-in-blank';
  const currentEvaluationResult = evaluationResults[currentQuestion.id];
  const liveMessage = showExplanation && !isTypedAnswerQuestion && currentEvaluationResult
    ? getEvaluationAnnouncement(currentEvaluationResult.isCorrect)
    : getProgressAnnouncement(currentQuestionIndex + 1, questions.length);

  return (
    <div className="max-w-3xl mx-auto">
      <LiveRegion message={liveMessage} />
      <OnboardingTour
        steps={quizTourSteps}
        run={runQuizTour}
        onComplete={() => {
          completeQuizTour();
          setRunQuizTour(false);
        }}
      />
      {/* Mode Badge */}
      <div id="tour-quiz-mode-badge" className="mb-4 flex items-center gap-2">
        <div className={`px-4 py-2 rounded-lg inline-flex items-center gap-2 ${
          isAssessmentMode
            ? 'bg-assessment-100 dark:bg-assessment-900/30 text-assessment-800 dark:text-assessment-200'
            : 'bg-practice-100 dark:bg-practice-900/30 text-practice-800 dark:text-practice-200'
        }`}>
          <span>{isAssessmentMode ? '📝' : '📚'}</span>
          <span className="font-semibold">{modeConfig.label}</span>
        </div>
        {adaptive && (
          <div className="px-3 py-2 rounded-lg bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200 inline-flex items-center gap-1">
            <span className="font-semibold text-sm">Adaptive</span>
          </div>
        )}
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <div className="flex items-start gap-2">
            <span className="text-yellow-600 dark:text-yellow-400">⚠️</span>
            <div>
              {warnings.map((warning, idx) => (
                <p key={idx} className="text-sm text-yellow-800 dark:text-yellow-200">
                  {warning}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            {displayTitle}
          </h2>
          <p className="text-gray-600 dark:text-gray-300">
            {difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} Level
            {topic && ` • ${topic}`}
          </p>
        </div>
        <div id="tour-quiz-counter" className="text-sm font-semibold text-gray-600 dark:text-gray-300">
          Question {currentQuestionIndex + 1} of {questions.length}
        </div>
      </div>

      {/* Render TypedAnswerQuestion for writing and fill-in-blank types */}
      <div id="tour-quiz-answer-area">
      {(currentQuestion.type === 'writing' || currentQuestion.type === 'fill-in-blank') ? (
        <div className="space-y-6">
          <TypedAnswerQuestion
            question={currentQuestion}
            onSubmit={handleTypedAnswerSubmit}
            showHints={true}
            isSuperuser={effectiveIsSuperuser}
          />

          {/* Navigation for typed answer questions */}
          {showExplanation && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
              <button
                onClick={handleNextFromExplanation}
                disabled={nextLocked}
                className="w-full py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-indigo-400 disabled:cursor-not-allowed transition-colors font-semibold"
              >
                {currentQuestionIndex === questions.length - 1 ? 'Finish Quiz' : 'Next Question →'}
                {countdown !== null && ` (${countdown}s)`}
              </button>
            </div>
          )}
        </div>
      ) : (
        <QuizQuestionView
          currentQuestion={currentQuestion}
          currentQuestionIndex={currentQuestionIndex}
          questionCount={questions.length}
          userAnswers={userAnswers}
          setUserAnswers={setUserAnswers}
          evaluationResults={evaluationResults}
          setEvaluationResults={setEvaluationResults}
          showExplanation={showExplanation}
          setShowExplanation={setShowExplanation}
          effectiveIsSuperuser={effectiveIsSuperuser}
          hasAnswered={hasAnswered}
          nextLocked={nextLocked}
          countdown={countdown}
          handleAnswer={handleAnswer}
          handleNextFromExplanation={handleNextFromExplanation}
        />
      )}
      </div>

      {/* Progress bar */}
      <div id="tour-quiz-progress" className="mt-6 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
        <div
          className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
          style={{
            width: `${((currentQuestionIndex + 1) / questions.length) * 100}%`,
          }}
        />
      </div>
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
