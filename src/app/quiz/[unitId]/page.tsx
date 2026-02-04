'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { Question } from '@/types';
import { units } from '@/lib/units';
import { getStoredStudyCode, getStudyCodeId } from '@/lib/study-codes';
import { saveQuizResults, saveQuizResultsLocally } from '@/lib/progress-tracking';
import { QuizMode, getModeConfig } from '@/lib/quiz-modes';
import {
  getSuperuserOverride,
  initGlobalSuperuserHelper,
  initSuperuserKeyboardShortcut,
  SUPERUSER_CHANGE_EVENT
} from '@/lib/superuser-override';
import TypedAnswerQuestion from '@/components/WritingQuestion';
import type { EvaluationResult } from '@/app/api/evaluate-writing/route';

interface TopicRecommendation {
  topic: string;
  count: number;
  resources: { url: string; title: string }[];
}

export default function QuizPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  const unitId = params.unitId as string;
  const topic = searchParams.get('topic') || '';
  const numQuestions = parseInt(searchParams.get('num') || '5');
  const difficulty = searchParams.get('difficulty') || 'beginner';
  const mode = (searchParams.get('mode') || 'practice') as QuizMode;
  const previewMode = searchParams.get('preview');

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
  const [studyCodeUuid, setStudyCodeUuid] = useState<string | null>(null);
  const [activeResultsTab, setActiveResultsTab] = useState<'answers' | 'studyGuide'>('answers');

  // Compute effective superuser status - sessionStorage override ALWAYS takes precedence
  // This ensures the override is respected immediately, even before React state updates
  const override = getSuperuserOverride();
  const effectiveIsSuperuser = override ?? isSuperuser;
  console.log(`🎯 QuizPage render: questionIndex=${currentQuestionIndex}, override=${override}, isSuperuser=${isSuperuser}, effective=${effectiveIsSuperuser}`);

  // Check superuser status from DB (sessionStorage override is handled at render time)
  const checkSuperuserStatus = useCallback(async (studyCodeId: string | null) => {
    if (!studyCodeId) {
      setIsSuperuser(false);
      return;
    }

    try {
      const response = await fetch(`/api/check-superuser?studyCodeId=${studyCodeId}`);
      if (response.ok) {
        const data = await response.json();
        setIsSuperuser(data.isSuperuser === true);
        console.log(`🔬 Superuser status from DB: ${data.isSuperuser ? 'YES' : 'NO'}`);
      }
    } catch (error) {
      console.error('Error checking superuser status:', error);
    }
  }, []);

  // Initialize study code UUID and check superuser status on mount
  useEffect(() => {
    async function initializeStudyCode() {
      const studyCode = getStoredStudyCode();
      if (!studyCode) {
        console.log('🔒 No study code found');
        return;
      }

      try {
        const studyCodeId = await getStudyCodeId(studyCode);
        if (!studyCodeId) {
          console.log('🔒 Could not get study code ID');
          return;
        }

        setStudyCodeUuid(studyCodeId);
        await checkSuperuserStatus(studyCodeId);
      } catch (error) {
        console.error('Error initializing study code:', error);
      }
    }

    initializeStudyCode();
  }, [checkSuperuserStatus]);

  // Re-check superuser override on each question change (for console/keyboard toggling)
  useEffect(() => {
    if (currentQuestionIndex > 0) {
      const override = getSuperuserOverride();
      console.log(`🔄 QuizPage useEffect[questionChange]: questionIndex=${currentQuestionIndex}, override=${override}`);
      if (override !== null) {
        setIsSuperuser(override);
      }
    }
  }, [currentQuestionIndex]);

  // Initialize superuser console helper and keyboard shortcut (Ctrl+Shift+S)
  // Also listen for superuser change events to update React state
  useEffect(() => {
    initGlobalSuperuserHelper();
    const cleanupKeyboard = initSuperuserKeyboardShortcut();

    // Listen for superuser toggle events (from keyboard shortcut or console)
    const handleSuperuserChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ enabled: boolean }>;
      console.log(`🔔 QuizPage: superuser change event received, setting isSuperuser to ${customEvent.detail.enabled}`);
      setIsSuperuser(customEvent.detail.enabled);
    };

    window.addEventListener(SUPERUSER_CHANGE_EVENT, handleSuperuserChange);

    return () => {
      cleanupKeyboard();
      window.removeEventListener(SUPERUSER_CHANGE_EVENT, handleSuperuserChange);
    };
  }, []);

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

      setQuestions(mockQuestions);
      setUserAnswers({
        'mock-1': 'Au revoir',
        'mock-2': 'Je suis etudiant',
        'mock-3': 'parle',
      });
      setEvaluationResults({
        'mock-2': {
          isCorrect: true,
          score: 85,
          hasCorrectAccents: false,
          feedback: 'Good translation! Watch the accent on "étudiant".',
          corrections: {},
          correctedAnswer: 'Je suis étudiant',
          metadata: {
            difficulty: 'intermediate',
            evaluationTier: 'fuzzy_logic',
            levenshteinSimilarity: 92,
            levenshteinThreshold: 80,
            matchedAgainst: 'primary_answer',
            evaluationReason: 'Fuzzy match passed threshold',
            usedClaudeAPI: false,
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
            levenshteinSimilarity: 100,
            matchedAgainst: 'primary_answer',
            evaluationReason: 'Exact match found',
            usedClaudeAPI: false,
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

  // Load questions on mount
  useEffect(() => {
    async function fetchQuestions() {
      try {
        setLoading(true);
        setWarnings([]);
        const response = await fetch('/api/generate-questions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unitId, topic, numQuestions, difficulty, mode }),
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
  }, [unitId, topic, numQuestions, difficulty, mode]);

  const currentQuestion = questions[currentQuestionIndex];
  const hasAnswered = currentQuestion && userAnswers[currentQuestion.id] !== undefined;

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
          usedClaudeAPI: false,
          matchedAgainst: 'primary_answer',
          evaluationReason: 'Exact match for multiple choice/true-false question'
        };
      }

      setEvaluationResults({
        ...evaluationResults,
        [currentQuestion.id]: evaluationResult
      });
    }
  };

  // Handler for typed answer question evaluation (writing and fill-in-blank)
  const handleTypedAnswerSubmit = (answer: string, evaluation: EvaluationResult) => {
    if (!currentQuestion) return;
    setUserAnswers({ ...userAnswers, [currentQuestion.id]: answer });
    setEvaluationResults({ ...evaluationResults, [currentQuestion.id]: evaluation });
    setShowExplanation(true);
  };

  const fetchStudyGuide = async () => {
    setLoadingStudyGuide(true);
    try {
      const incorrectQuestions = questions
        .filter((q) => {
          // For writing questions, check evaluation result
          if (q.type === 'writing' && evaluationResults[q.id]) {
            return !evaluationResults[q.id].isCorrect;
          }
          // For other questions, check direct answer match
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

  // Save quiz results to database
  const saveResults = async () => {
    const studyCode = getStoredStudyCode();
    if (!studyCode) return;

    const { correct } = calculateScore();
    const scorePercentage = Math.round((correct / questions.length) * 100);

    const result = {
      studyCode,
      unitId,
      difficulty: difficulty as 'beginner' | 'intermediate' | 'advanced',
      totalQuestions: questions.length,
      correctAnswers: correct,
      scorePercentage,
      questions,
      userAnswers,
    };

    try {
      await saveQuizResults(result);
      console.log('✅ Quiz results saved to database');
    } catch (error) {
      console.error('Failed to save quiz results:', error);
      // Fallback to localStorage
      saveQuizResultsLocally(result);
    }
  };

  const handleNext = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      setShowExplanation(false);
    } else {
      setShowResults(true);
      saveResults(); // Save quiz results when finishing
      fetchStudyGuide();
    }
  };

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) {
      setCurrentQuestionIndex(currentQuestionIndex - 1);
      setShowExplanation(false);
    }
  };

  const calculateScore = () => {
    let correct = 0;
    questions.forEach((q) => {
      // For writing questions, check evaluation result
      if (q.type === 'writing' && evaluationResults[q.id]) {
        if (evaluationResults[q.id].isCorrect) {
          correct++;
        }
      } else {
        // For other questions, check direct answer match
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
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
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
    const score = calculateScore();
    return (
      <div className="max-w-3xl mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-8">
          <div className="text-center mb-8">
            <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full mb-4 ${
              isAssessmentMode
                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200'
                : 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200'
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
              ? 'bg-gradient-to-r from-amber-500 to-orange-600'
              : 'bg-gradient-to-r from-indigo-500 to-purple-600'
          }`}>
            <div className="text-6xl font-bold mb-2">{score.percentage}%</div>
            <div className="text-xl">
              {score.correct} out of {score.total} correct
            </div>
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
              // For writing questions, use evaluation result; for others, direct comparison
              const isCorrect = q.type === 'writing' && evaluationResults[q.id]
                ? evaluationResults[q.id].isCorrect
                : userAnswer === q.correctAnswer;
              const evaluation = evaluationResults[q.id];

              return (
                <div
                  key={q.id}
                  className={`p-4 rounded-lg border-2 ${
                    isCorrect
                      ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                      : 'border-red-500 bg-red-50 dark:bg-red-900/20'
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-gray-900 dark:text-white">
                      {idx + 1}. {q.question}
                    </h3>
                    <div className="flex items-center gap-2">
                      {q.type === 'writing' && evaluation && (
                        <span className="text-sm font-semibold text-gray-600 dark:text-gray-400">
                          {evaluation.score}%
                        </span>
                      )}
                      <span className="text-2xl">{isCorrect ? '✅' : '❌'}</span>
                    </div>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-1">
                    Your answer: <span className="font-semibold">{userAnswer || 'Not answered'}</span>
                  </p>
                  {!isCorrect && q.type !== 'writing' && (
                    <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                      Correct answer: <span className="font-semibold text-green-700 dark:text-green-400">{q.correctAnswer}</span>
                    </p>
                  )}
                  {q.type === 'writing' && evaluation && (
                    <div className="mt-2 space-y-2">
                      {evaluation.correctedAnswer && (
                        <p className="text-sm text-gray-600 dark:text-gray-300">
                          Suggested answer: <span className="font-semibold text-green-700 dark:text-green-400">{evaluation.correctedAnswer}</span>
                        </p>
                      )}
                      {evaluation.feedback && (
                        <p className="text-sm text-blue-800 dark:text-blue-200 bg-blue-50 dark:bg-blue-900/20 p-2 rounded">
                          💡 {evaluation.feedback}
                        </p>
                      )}
                    </div>
                  )}
                  {q.explanation && q.type !== 'writing' && (
                    <p className="text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 p-3 rounded mt-2">
                      💡 {q.explanation}
                    </p>
                  )}

                  {/* Superuser Question Metadata - For writing questions */}
                  {effectiveIsSuperuser && q.type === 'writing' && (
                    <div className="mt-4 pt-4 border-t border-gray-300 dark:border-gray-600">
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
                              {q.writingType?.replace(/_/g, ' ') || 'N/A'}
                            </span>
                          </div>
                          <div>
                            <span className="font-semibold text-purple-900 dark:text-purple-200">Difficulty:</span>
                            <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                              {q.difficulty}
                            </span>
                          </div>
                          <div>
                            <span className="font-semibold text-purple-900 dark:text-purple-200">Topic:</span>
                            <span className="ml-2 text-purple-800 dark:text-purple-300">
                              {q.topic || 'N/A'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Superuser Evaluation Metadata - Show for all question types */}
                  {effectiveIsSuperuser && evaluation && evaluation.metadata && (
                    <div className="mt-4 pt-4 border-t border-gray-300 dark:border-gray-600">
                      <h5 className="text-sm font-semibold text-purple-700 dark:text-purple-300 mb-3 flex items-center gap-2">
                        <span className="text-lg">🔬</span>
                        Evaluation Metadata (Superuser)
                      </h5>
                      <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4 space-y-2">
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <span className="font-semibold text-purple-900 dark:text-purple-200">Question Type:</span>
                            <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                              {q.type === 'writing'
                                ? `Writing (${q.writingType?.replace(/_/g, ' ')})`
                                : q.type.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                            </span>
                          </div>
                          <div>
                            <span className="font-semibold text-purple-900 dark:text-purple-200">Difficulty:</span>
                            <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">{evaluation.metadata.difficulty}</span>
                          </div>
                          <div>
                            <span className="font-semibold text-purple-900 dark:text-purple-200">Evaluation Tier:</span>
                            <span className="ml-2 text-purple-800 dark:text-purple-300">
                              {(() => {
                                const tierMap: Record<string, string> = {
                                  'empty_check': '1 - Empty Check',
                                  'exact_match': '2 - Exact Match',
                                  'fuzzy_logic': '3 - Fuzzy Logic',
                                  'claude_api': '4  Semantic API'
                                };
                                return tierMap[evaluation.metadata!.evaluationTier] || evaluation.metadata!.evaluationTier;
                              })()}
                            </span>
                          </div>

                          {/* Levenshtein Similarity - shown for tiers 2 and 3 */}
                          {evaluation.metadata.levenshteinSimilarity !== undefined && (
                            <div>
                              <span className="font-semibold text-purple-900 dark:text-purple-200">Levenshtein Similarity:</span>
                              <span className="ml-2 text-purple-800 dark:text-purple-300">{evaluation.metadata.levenshteinSimilarity}%</span>
                            </div>
                          )}

                          {/* Levenshtein Threshold - shown for tier 3 */}
                          {evaluation.metadata.levenshteinThreshold !== undefined && (
                            <div>
                              <span className="font-semibold text-purple-900 dark:text-purple-200">Similarity Threshold:</span>
                              <span className="ml-2 text-purple-800 dark:text-purple-300">{evaluation.metadata.levenshteinThreshold}%</span>
                            </div>
                          )}

                          {/* Semantic Confidence - shown for tier 4 */}
                          {evaluation.metadata.claudeConfidence !== undefined && (
                            <div>
                              <span className="font-semibold text-purple-900 dark:text-purple-200">Semantic Confidence:</span>
                              <span className="ml-2 text-purple-800 dark:text-purple-300">{evaluation.metadata.claudeConfidence}%</span>
                            </div>
                          )}

                          {/* Matched Against */}
                          <div>
                            <span className="font-semibold text-purple-900 dark:text-purple-200">Matched Against:</span>
                            <span className="ml-2 text-purple-800 dark:text-purple-300">
                              {(() => {
                                const matchMap: Record<string, string> = {
                                  'primary_answer': 'Primary Answer',
                                  'acceptable_variation': `Variation #${(evaluation.metadata!.matchedVariationIndex ?? 0) + 1}`,
                                  'none': 'None'
                                };
                                return matchMap[evaluation.metadata!.matchedAgainst] || evaluation.metadata!.matchedAgainst;
                              })()}
                            </span>
                          </div>
{/*
                          <div>
                            <span className="font-semibold text-purple-900 dark:text-purple-200">Used Semantic API:</span>
                            <span className="ml-2 text-purple-800 dark:text-purple-300">
                              {evaluation.metadata.usedClaudeAPI ? 'Yes' : 'No'}
                            </span>
                          </div>
*/}
                          {evaluation.metadata.modelUsed && (
                            <div className="col-span-2">
                              <span className="font-semibold text-purple-900 dark:text-purple-200">Model:</span>
                              <span className="ml-2 text-purple-800 dark:text-purple-300 font-mono text-xs">
                                {evaluation.metadata.modelUsed}
                              </span>
                            </div>
                          )}

                          {/* Evaluation Reason - full width */}
                          {evaluation.metadata.evaluationReason && (
                            <div className="col-span-2">
                              <span className="font-semibold text-purple-900 dark:text-purple-200">Evaluation Reason:</span>
                              <span className="ml-2 text-purple-800 dark:text-purple-300">
                                {evaluation.metadata.evaluationReason}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
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
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
                    <p className="text-blue-800 dark:text-blue-200">Generating your personalized study guide...</p>
                  </div>
                </div>
              )}

              {!loadingStudyGuide && studyGuide.length > 0 && (
                <>
                  <div className="bg-gradient-to-r from-purple-500 to-indigo-600 rounded-lg p-6 text-white mb-4">
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
                                    className="w-5 h-5 text-red-600 flex-shrink-0"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                  >
                                    <path d="M10 0C4.477 0 0 4.477 0 10s4.477 10 10 10 10-4.477 10-10S15.523 0 10 0zm3.5 10.5l-5 3a.5.5 0 01-.75-.433v-6a.5.5 0 01.75-.433l5 3a.5.5 0 010 .866z" />
                                  </svg>
                                  <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-purple-700 dark:group-hover:text-purple-300 break-words">
                                    {resource.title || 'Video Resource'}
                                  </span>
                                  <svg
                                    className="w-4 h-4 ml-auto text-gray-400 group-hover:text-purple-600 flex-shrink-0"
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
                    You've mastered this material. Keep up the excellent work!
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

          <div className="flex gap-4">
            <button
              onClick={() => router.push('/')}
              className="flex-1 py-3 px-6 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
            >
              Practice Again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex-1 py-3 px-6 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg font-semibold hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              Retry Quiz
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!currentQuestion) {
    return null;
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Mode Badge */}
      <div className={`mb-4 px-4 py-2 rounded-lg inline-flex items-center gap-2 ${
        isAssessmentMode
          ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200'
          : 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200'
      }`}>
        <span>{isAssessmentMode ? '📝' : '📚'}</span>
        <span className="font-semibold">{modeConfig.label}</span>
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
        <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">
          Question {currentQuestionIndex + 1} of {questions.length}
        </div>
      </div>

      {/* Render TypedAnswerQuestion for writing and fill-in-blank types */}
      {(currentQuestion.type === 'writing' || currentQuestion.type === 'fill-in-blank') ? (
        <div className="space-y-6">
          <TypedAnswerQuestion
            question={currentQuestion}
            onSubmit={handleTypedAnswerSubmit}
            showHints={true}
            isSuperuser={effectiveIsSuperuser}
            studyCodeUuid={studyCodeUuid}
          />

          {/* Navigation for typed answer questions */}
          {showExplanation && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
              <button
                onClick={handleNext}
                className="w-full py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-semibold"
              >
                {currentQuestionIndex === questions.length - 1 ? 'Finish Quiz' : 'Next Question →'}
              </button>
            </div>
          )}
        </div>
      ) : (
        // Standard question rendering for non-writing questions
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-8">
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <span className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 rounded-full text-sm font-semibold">
                {currentQuestion.type.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
              </span>
            </div>
            <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
              {currentQuestion.question}
            </h3>

            {/* Superuser Metadata - Question Screen */}
            {effectiveIsSuperuser && !showExplanation && (
              <div className="mb-4 p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg">
                <h5 className="text-sm font-semibold text-purple-900 dark:text-purple-300 mb-2 flex items-center gap-2">
                  <span className="text-lg">🔬</span>
                  Question Metadata (Superuser)
                </h5>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="font-semibold text-purple-900 dark:text-purple-200">Question Type:</span>
                    <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                      {currentQuestion.type.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                    </span>
                  </div>
                  <div>
                    <span className="font-semibold text-purple-900 dark:text-purple-200">Difficulty:</span>
                    <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                      {currentQuestion.difficulty}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="font-semibold text-purple-900 dark:text-purple-200">Topic:</span>
                    <span className="ml-2 text-purple-800 dark:text-purple-300">
                      {currentQuestion.topic}
                    </span>
                  </div>
                </div>
              </div>
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
                          ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                          : isSelected
                          ? 'border-red-500 bg-red-50 dark:bg-red-900/20'
                          : 'border-gray-200 dark:border-gray-700'
                        : isSelected
                        ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30'
                        : 'border-gray-200 dark:border-gray-700 hover:border-indigo-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-900 dark:text-white">{option}</span>
                      {showCorrectness && isCorrect && <span className="text-2xl">✅</span>}
                      {showCorrectness && !isCorrect && isSelected && <span className="text-2xl">❌</span>}
                    </div>
                  </button>
                );
              })}
          </div>

          {showExplanation && (
            <div className="mb-6 space-y-4">
              <div className={`p-4 rounded-lg border-2 ${
                userAnswers[currentQuestion.id] === currentQuestion.correctAnswer
                  ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                  : 'border-red-500 bg-red-50 dark:bg-red-900/20'
              }`}>
                <p className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
                  {userAnswers[currentQuestion.id] === currentQuestion.correctAnswer ? (
                    <span className="text-green-700 dark:text-green-400">✅ Correct!</span>
                  ) : (
                    <span className="text-red-700 dark:text-red-400">❌ Incorrect</span>
                  )}
                </p>
                {userAnswers[currentQuestion.id] !== currentQuestion.correctAnswer && (
                  <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
                    Correct answer: <span className="font-semibold text-green-700 dark:text-green-400">{currentQuestion.correctAnswer}</span>
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
                <div className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg mb-4">
                  <h5 className="text-sm font-semibold text-purple-900 dark:text-purple-300 mb-2 flex items-center gap-2">
                    <span className="text-lg">🔬</span>
                    Question Metadata (Superuser)
                  </h5>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="font-semibold text-purple-900 dark:text-purple-200">Question Type:</span>
                      <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                        {currentQuestion.type.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                      </span>
                    </div>
                    <div>
                      <span className="font-semibold text-purple-900 dark:text-purple-200">Difficulty:</span>
                      <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
                        {currentQuestion.difficulty}
                      </span>
                    </div>
                    <div className="col-span-2">
                      <span className="font-semibold text-purple-900 dark:text-purple-200">Topic:</span>
                      <span className="ml-2 text-purple-800 dark:text-purple-300">
                        {currentQuestion.topic}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Superuser Evaluation Metadata for Non-Writing Questions */}
              {effectiveIsSuperuser && evaluationResults[currentQuestion.id]?.metadata && (() => {
                const metadata = evaluationResults[currentQuestion.id].metadata!;
                return (
                  <div className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg">
                    <h5 className="text-sm font-semibold text-purple-900 dark:text-purple-300 mb-2 flex items-center gap-2">
                      <span className="text-lg">🔬</span>
                      Evaluation Metadata (Superuser)
                    </h5>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Evaluation Tier:</span>
                        <span className="ml-2 text-purple-800 dark:text-purple-300">
                          {(() => {
                            const tierMap: Record<string, string> = {
                              'empty_check': '1. Empty Check',
                              'exact_match': '2. Exact Match',
                              'fuzzy_logic': '3. Fuzzy Logic',
                              'claude_api': '4. Semantic API'
                            };
                            return tierMap[metadata.evaluationTier] || metadata.evaluationTier;
                          })()}
                        </span>
                      </div>

                      {/* Levenshtein Similarity - shown for tiers 2 and 3 */}
                      {metadata.levenshteinSimilarity !== undefined && (
                        <div>
                          <span className="font-semibold text-purple-900 dark:text-purple-200">Levenshtein Similarity:</span>
                          <span className="ml-2 text-purple-800 dark:text-purple-300">
                            {metadata.levenshteinSimilarity}%
                          </span>
                        </div>
                      )}

                      {/* Levenshtein Threshold - shown for tier 3 */}
                      {metadata.levenshteinThreshold !== undefined && (
                        <div>
                          <span className="font-semibold text-purple-900 dark:text-purple-200">Similarity Threshold:</span>
                          <span className="ml-2 text-purple-800 dark:text-purple-300">
                            {metadata.levenshteinThreshold}%
                          </span>
                        </div>
                      )}

                      {/* Semantic Confidence - shown for tier 4 */}
                      {metadata.claudeConfidence !== undefined && (
                        <div>
                          <span className="font-semibold text-purple-900 dark:text-purple-200">Semantic Confidence:</span>
                          <span className="ml-2 text-purple-800 dark:text-purple-300">
                            {metadata.claudeConfidence}%
                          </span>
                        </div>
                      )}

                      {/* Matched Against */}
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Matched Against:</span>
                        <span className="ml-2 text-purple-800 dark:text-purple-300">
                          {(() => {
                            const matchMap: Record<string, string> = {
                              'primary_answer': 'Primary Answer',
                              'acceptable_variation': `Variation #${(metadata.matchedVariationIndex ?? 0) + 1}`,
                              'none': 'None'
                            };
                            return matchMap[metadata.matchedAgainst] || metadata.matchedAgainst;
                          })()}
                        </span>
                      </div>
{/*}
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Used Semantic API:</span>
                        <span className="ml-2 text-purple-800 dark:text-purple-300">
                          {metadata.usedClaudeAPI ? 'Yes' : 'No'}
                        </span>
                      </div>
*/}
                      {metadata.modelUsed && (
                        <div>
                          <span className="font-semibold text-purple-900 dark:text-purple-200">Model:</span>
                          <span className="ml-2 text-purple-800 dark:text-purple-300 font-mono text-xs">
                            {metadata.modelUsed}
                          </span>
                        </div>
                      )}

                      {/* Evaluation Reason - full width */}
                      {metadata.evaluationReason && (
                        <div className="col-span-2">
                          <span className="font-semibold text-purple-900 dark:text-purple-200">Evaluation Reason:</span>
                          <span className="ml-2 text-purple-800 dark:text-purple-300">
                            {metadata.evaluationReason}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
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
                  onClick={handleNext}
                  className="w-full py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
                >
                  {currentQuestionIndex === questions.length - 1 ? 'Finish Quiz' : 'Next Question →'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Progress bar */}
      <div className="mt-6 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
        <div
          className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
          style={{
            width: `${((currentQuestionIndex + 1) / questions.length) * 100}%`,
          }}
        />
      </div>
    </div>
  );
}
