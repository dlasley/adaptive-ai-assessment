import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { Question } from '@adaptive/shared/types';
import { useUnits } from '@/hooks/use-units';
import { getStoredStudyCode, getStudentDashboard, hasActiveStudentSession } from '@/lib/study-codes';
import { saveQuizResults, saveQuizResultsLocally, updateLeitnerStateForQuestion } from '@/lib/progress-tracking';
import { QuizMode, getModeConfig } from '@/lib/quiz-modes';
import { FEATURES } from '@/lib/feature-flags';
import type { Difficulty } from '@adaptive/shared/enums';
import { isNextLocked, startWrongAnswerCountdown, WrongAnswerCountdown } from '@/lib/wrong-answer-countdown';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import { useOnboarding } from '@/hooks/use-onboarding';
import { useCelebration } from '@/hooks/use-celebration';

export interface TopicRecommendation {
  topic: string;
  count: number;
  resources: { url: string; title: string }[];
}

/**
 * Every piece of quiz-taking state, its side effects (question loading, session/superuser
 * resolution, the wrong-answer countdown, the preview-mode data seed, focus management, the
 * onboarding-tour trigger), and the handlers that mutate it. Carries no JSX — the page component
 * renders from what this returns.
 */
export function useQuizSession() {
  const params = useParams();
  const searchParams = useSearchParams();

  const unitId = params.unitId as string;
  const topic = searchParams.get('topic') || '';
  const numQuestions = parseInt(searchParams.get('num') || '5');
  const difficulty = searchParams.get('difficulty') || 'beginner';
  const mode = (searchParams.get('mode') || 'practice') as QuizMode;
  const adaptive = searchParams.get('adaptive') === 'true';
  const previewMode = searchParams.get('preview');
  const { units } = useUnits();

  const unit = unitId === 'all' ? null : units.find((u) => u.id === unitId);
  const displayTitle = unitId === 'all' ? 'All Units' : unit?.title || 'Quiz';
  const modeConfig = getModeConfig(mode);
  const isAssessmentMode = mode === 'assessment';

  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<string, string>>({});
  const [evaluationResults, setEvaluationResults] = useState<Record<string, EvaluationResult>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);
  const [studyGuide, setStudyGuide] = useState<TopicRecommendation[]>([]);
  const [loadingStudyGuide, setLoadingStudyGuide] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [hasStudentSession, setHasStudentSession] = useState<boolean | null>(null);
  const [activeResultsTab, setActiveResultsTab] = useState<'answers' | 'studyGuide'>('answers');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownTotal, setCountdownTotal] = useState<number | null>(null);
  const [countdownOverride, setCountdownOverride] = useState<number | null>(null);
  const countdownControllerRef = useRef<WrongAnswerCountdown | null>(null);
  const { shouldShowQuizTour, completeQuizTour } = useOnboarding();
  const [runQuizTour, setRunQuizTour] = useState(false);
  const {
    milestones, showOverlay, streakToast,
    recordAnswer, detectAndCelebrate, dismissOverlay, dismissStreakToast,
  } = useCelebration();

  // Start countdown when a wrong answer explanation is shown
  useEffect(() => {
    // Clear any existing countdown
    countdownControllerRef.current?.stop();
    countdownControllerRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- paired with stopping the countdown controller, an external timer
    setCountdown(null);
    setCountdownTotal(null);

    const question = questions[currentQuestionIndex];
    if (!showExplanation || !question) return;

    const seconds = countdownOverride ?? FEATURES.WRONG_ANSWER_COUNTDOWN_SECONDS;
    if (seconds <= 0) return;

    const isWrong = evaluationResults[question.id]?.isCorrect === false;
    if (!isWrong) return;

    setCountdownTotal(seconds);
    countdownControllerRef.current = startWrongAnswerCountdown(seconds, setCountdown);

    return () => {
      countdownControllerRef.current?.stop();
      countdownControllerRef.current = null;
    };
  }, [showExplanation, questions, currentQuestionIndex, evaluationResults, countdownOverride]);

  const effectiveIsSuperuser = isSuperuser;

  // Check superuser status from the session cookie (no client-supplied id)
  const checkSuperuserStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/check-superuser');
      if (response.ok) {
        const data = await response.json();
        setIsSuperuser(data.isSuperuser === true);
        setCountdownOverride(data.wrongAnswerCountdown ?? null);
      }
    } catch (error) {
      console.error('Error checking superuser status:', error);
    }
  }, []);

  // Resolve session readiness and check superuser status on mount
  useEffect(() => {
    async function initializeSession() {
      const studyCode = getStoredStudyCode();
      if (!studyCode) {
        setHasStudentSession(false);
        return;
      }

      const active = await hasActiveStudentSession();
      setHasStudentSession(active);
      if (active) {
        await checkSuperuserStatus();
      }
    }

    initializeSession();
  }, [checkSuperuserStatus]);

  // Preview mode: show results screen with mock data for testing UI
  useEffect(() => {
    if (previewMode === 'results') {
      const mockQuestions: Question[] = [
        {
          id: 'mock-1',
          unitId: 'preview',
          type: 'multiple-choice',
          question: 'What is "hello" in French?',
          options: ['Bonjour', 'Au revoir', 'Merci', 'Oui'],
          correctAnswer: 'Bonjour',
          explanation: 'Bonjour is the standard French greeting.',
          difficulty: 'beginner',
          topic: 'Greetings',
        },
        {
          id: 'mock-2',
          unitId: 'preview',
          type: 'writing',
          question: 'Translate: "I am a student"',
          correctAnswer: 'Je suis étudiant',
          difficulty: 'intermediate',
          topic: 'Self Introduction',
          writingType: 'translation',
        },
        {
          id: 'mock-3',
          unitId: 'preview',
          type: 'fill-in-blank',
          question: 'Complete: Je ___ français. (I speak French)',
          correctAnswer: 'parle',
          difficulty: 'beginner',
          topic: 'Verbs',
        },
      ];

      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time preview seed gated by a URL query param, not derivable from render
      setQuestions(mockQuestions);
      setUserAnswers({
        'mock-1': 'Au revoir',
        'mock-2': 'Je suis etudiant',
        'mock-3': 'parle',
      });
      setEvaluationResults({
        'mock-2': {
          isCorrect: true,
          score: 96,
          hasCorrectAccents: false,
          feedback: 'Good translation! Watch the accent on "étudiant".',
          corrections: {},
          correctedAnswer: 'Je suis étudiant',
          metadata: {
            difficulty: 'intermediate',
            evaluationTier: 'fuzzy_match',
            matchKind: 'exact',
            matchedAgainst: 'acceptable_variation',
            matchedVariationIndex: 0,
            evaluationReason: 'Exact match against acceptable variation #1',
            usedSemanticTier: false,
          },
        },
        'mock-3': {
          isCorrect: true,
          score: 100,
          hasCorrectAccents: true,
          feedback: 'Perfect!',
          corrections: {},
          metadata: {
            difficulty: 'beginner',
            evaluationTier: 'exact_match',
            matchKind: 'exact',
            matchedAgainst: 'primary_answer',
            evaluationReason: 'Exact match found',
            usedSemanticTier: false,
          },
        },
      });
      setStudyGuide([
        {
          topic: 'Greetings',
          count: 1,
          resources: [
            { url: 'https://youtube.com/example1', title: 'French Greetings for Beginners' },
            { url: 'https://youtube.com/example2', title: 'Common French Phrases' },
          ],
        },
      ]);
      setShowResults(true);
      setLoading(false);
    }
  }, [previewMode]);

  // Load questions on mount (defer when adaptive mode needs session readiness)
  useEffect(() => {
    if (adaptive && !hasStudentSession) return; // Wait for the session check to resolve

    async function fetchQuestions() {
      try {
        setLoading(true);
        setWarnings([]);

        const requestBody: Record<string, unknown> = { unitId, topic, numQuestions, difficulty, mode };
        if (adaptive && hasStudentSession) {
          requestBody.leitnerMode = true;
        }

        const response = await fetch('/api/generate-questions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          throw new Error('Failed to generate questions');
        }

        const data = await response.json();
        setQuestions(data.questions);
        if (data.warnings && data.warnings.length > 0) {
          setWarnings(data.warnings);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    }

    fetchQuestions();
  }, [unitId, topic, numQuestions, difficulty, mode, adaptive, hasStudentSession]);

  // Auto-start quiz tour on first quiz
  useEffect(() => {
    if (!loading && questions.length > 0 && shouldShowQuizTour && !showResults) {
      const timer = setTimeout(() => setRunQuizTour(true), 500);
      return () => clearTimeout(timer);
    }
  }, [loading, questions.length, shouldShowQuizTour, showResults]);

  const currentQuestion = questions[currentQuestionIndex];
  const hasAnswered = currentQuestion !== undefined && userAnswers[currentQuestion.id] !== undefined;

  // Move focus to the new question's heading whenever it changes, since
  // the button that triggered the change unmounts along with the old
  // question and would otherwise drop focus to <body>.
  useEffect(() => {
    if (loading || showResults || !currentQuestion) return;
    document.getElementById('question-heading')?.focus();
  }, [currentQuestionIndex, loading, showResults, currentQuestion]);

  // Move focus to the MCQ/true-false feedback region once it's revealed.
  // (Typed-answer questions focus their own feedback region; see
  // writing-question/index.tsx.)
  useEffect(() => {
    if (!showExplanation || !currentQuestion) return;
    if (currentQuestion.type === 'writing' || currentQuestion.type === 'fill-in-blank') return;
    document.getElementById('feedback-region')?.focus();
  }, [showExplanation, currentQuestion]);

  const handleAnswer = async (answer: string) => {
    if (!currentQuestion) return;
    setUserAnswers({ ...userAnswers, [currentQuestion.id]: answer });
    setShowExplanation(false);

    // For non-typed-answer questions (multiple-choice, true-false), use exact match
    if (currentQuestion.type !== 'writing' && currentQuestion.type !== 'fill-in-blank') {
      const isCorrect = answer === currentQuestion.correctAnswer;
      const evaluationResult: EvaluationResult = {
        isCorrect,
        score: isCorrect ? 100 : 0,
        hasCorrectAccents: true, // Not applicable for non-writing
        feedback: isCorrect ? 'Correct!' : `The correct answer is: ${currentQuestion.correctAnswer}`,
        corrections: {},
        correctedAnswer: isCorrect ? undefined : currentQuestion.correctAnswer,
      };

      // Add metadata for superusers
      if (effectiveIsSuperuser) {
        evaluationResult.metadata = {
          difficulty: currentQuestion.difficulty,
          evaluationTier: 'exact_match',
          usedSemanticTier: false,
          matchedAgainst: 'primary_answer',
          evaluationReason: 'Exact match for multiple choice/true-false question'
        };
      }

      setEvaluationResults({
        ...evaluationResults,
        [currentQuestion.id]: evaluationResult
      });
      recordAnswer(isCorrect);
      if (FEATURES.LEITNER_MODE && hasStudentSession) {
        updateLeitnerStateForQuestion(currentQuestion.id, isCorrect);
      }
    }
  };

  // Handler for typed answer question evaluation (writing and fill-in-blank)
  const handleTypedAnswerSubmit = (answer: string, evaluation: EvaluationResult) => {
    if (!currentQuestion) return;
    setUserAnswers({ ...userAnswers, [currentQuestion.id]: answer });
    setEvaluationResults({ ...evaluationResults, [currentQuestion.id]: evaluation });
    setShowExplanation(true);
    recordAnswer(evaluation.isCorrect);
    if (FEATURES.LEITNER_MODE && hasStudentSession) {
      updateLeitnerStateForQuestion(currentQuestion.id, evaluation.isCorrect);
    }
  };

  const fetchStudyGuide = async () => {
    setLoadingStudyGuide(true);
    try {
      const incorrectQuestions = questions
        .filter((q) => {
          // For typed-answer questions (writing and fill-in-blank), use evaluation result
          if ((q.type === 'writing' || q.type === 'fill-in-blank') && evaluationResults[q.id]) {
            return !evaluationResults[q.id].isCorrect;
          }
          // For MCQ/true-false, check direct answer match
          return userAnswers[q.id] !== q.correctAnswer;
        })
        .map((q) => ({ topic: q.topic, unitId: q.unitId }));

      if (incorrectQuestions.length === 0) {
        setStudyGuide([]);
        return;
      }

      const response = await fetch('/api/study-guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incorrectQuestions }),
      });

      if (response.ok) {
        const data = await response.json();
        setStudyGuide(data.recommendations || []);
      }
    } catch (error) {
      console.error('Error fetching study guide:', error);
    } finally {
      setLoadingStudyGuide(false);
    }
  };

  const calculateScore = useCallback(() => {
    let correct = 0;
    questions.forEach((q) => {
      // For typed-answer questions (writing and fill-in-blank), use evaluation result
      if ((q.type === 'writing' || q.type === 'fill-in-blank') && evaluationResults[q.id]) {
        if (evaluationResults[q.id].isCorrect) {
          correct++;
        }
      } else {
        // For MCQ/true-false, check direct answer match
        if (userAnswers[q.id] === q.correctAnswer) {
          correct++;
        }
      }
    });
    return {
      correct,
      total: questions.length,
      percentage: Math.round((correct / questions.length) * 100),
    };
  }, [questions, evaluationResults, userAnswers]);

  // Save quiz results to database
  const saveResults = async () => {
    const studyCode = getStoredStudyCode();
    if (!studyCode) return;

    const { correct } = calculateScore();
    const scorePercentage = Math.round((correct / questions.length) * 100);

    const result = {
      unitId,
      difficulty: difficulty as Difficulty,
      totalQuestions: questions.length,
      correctAnswers: correct,
      scorePercentage,
      questions,
      userAnswers,
      evaluationResults,
    };

    try {
      const quizHistoryId = await saveQuizResults(result);
      if (!quizHistoryId) throw new Error('Server did not confirm the save');
    } catch (error) {
      console.error('Failed to save quiz results:', error);
      // Fallback to localStorage
      saveQuizResultsLocally(result);
    }
  };

  const handleNext = async () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      setShowExplanation(false);
    } else {
      // Fetch pre-save data for milestone detection
      const studyCode = getStoredStudyCode();
      const score = calculateScore();
      if (studyCode) {
        try {
          const dashboard = await getStudentDashboard();
          if (dashboard) {
            const { profile, quizHistory: preHistory } = dashboard;
            await detectAndCelebrate({
              scorePercentage: score.percentage,
              unitId,
              difficulty,
              isAssessmentMode,
              quizHistory: preHistory,
              previousProgress: {
                totalQuizzes: profile.totalQuizzes,
                totalQuestions: profile.totalQuestions,
                correctAnswers: profile.correctAnswers,
                overallAccuracy:
                  profile.totalQuestions > 0
                    ? Math.round((profile.correctAnswers / profile.totalQuestions) * 100 * 100) / 100
                    : 0,
              },
              currentCorrectAnswers: score.correct,
              currentTotalQuestions: score.total,
            });
          }
        } catch {
          // Milestone detection failure should not block results
        }
      }
      setShowResults(true);
      saveResults();
      fetchStudyGuide();
    }
  };

  const nextLocked = isNextLocked(countdownTotal, countdown, FEATURES.WRONG_ANSWER_MIN_WAIT_SECONDS);

  // Advancing mid-countdown stops the timer so it cannot tick into the next
  // question or the results screen.
  const handleNextFromExplanation = () => {
    countdownControllerRef.current?.stop();
    countdownControllerRef.current = null;
    setCountdown(null);
    setCountdownTotal(null);
    handleNext();
  };

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
      setShowExplanation(false);
    }
  };

  return {
    // Route/query-derived
    unitId, topic, difficulty, mode, adaptive, unit, displayTitle, modeConfig, isAssessmentMode,
    // Core quiz state
    questions, currentQuestionIndex, userAnswers, setUserAnswers, evaluationResults, setEvaluationResults,
    loading, error, warnings,
    showResults, showExplanation, setShowExplanation,
    studyGuide, loadingStudyGuide,
    activeResultsTab, setActiveResultsTab,
    countdown, countdownTotal,
    hasStudentSession,
    effectiveIsSuperuser,
    // Onboarding tour
    runQuizTour, setRunQuizTour, completeQuizTour,
    // Celebration
    milestones, showOverlay, streakToast, dismissOverlay, dismissStreakToast,
    // Derived
    currentQuestion, hasAnswered, nextLocked, calculateScore,
    // Handlers
    handleAnswer, handleTypedAnswerSubmit, handleNext, handleNextFromExplanation, handlePrevious,
  };
}
