'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import { Question } from '@/types';
import { units } from '@/lib/units';
import { FEATURES } from '@/lib/feature-flags';
import { getStoredStudyCode, getStudyCodeId } from '@/lib/study-codes';
import { saveQuizResults, saveQuizResultsLocally } from '@/lib/progress-tracking';
import WritingQuestionComponent from '@/components/WritingQuestion';
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

  const unit = unitId === 'all' ? null : units.find((u) => u.id === unitId);
  const displayTitle = unitId === 'all' ? 'All Units' : unit?.title || 'Quiz';

  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<string, string>>({});
  const [evaluationResults, setEvaluationResults] = useState<Record<string, EvaluationResult>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);
  const [studyGuide, setStudyGuide] = useState<TopicRecommendation[]>([]);
  const [loadingStudyGuide, setLoadingStudyGuide] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [studyCodeUuid, setStudyCodeUuid] = useState<string | null>(null);
  const [isEvaluatingFillInBlank, setIsEvaluatingFillInBlank] = useState(false);

  // Initialize study code UUID and check superuser status
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

        const response = await fetch(`/api/check-superuser?studyCodeId=${studyCodeId}`);
        if (response.ok) {
          const data = await response.json();
          setIsSuperuser(data.isSuperuser);
          console.log(`🔬 Superuser status: ${data.isSuperuser ? 'YES' : 'NO'}`);
        }
      } catch (error) {
        console.error('Error initializing study code:', error);
      }
    }

    initializeStudyCode();
  }, []);

  // Load questions on mount
  useEffect(() => {
    async function fetchQuestions() {
      try {
        setLoading(true);
        const response = await fetch('/api/generate-questions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unitId, topic, numQuestions, difficulty }),
        });

        if (!response.ok) {
          throw new Error('Failed to generate questions');
        }

        const data = await response.json();
        setQuestions(data.questions);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    }

    fetchQuestions();
  }, [unitId, topic, numQuestions, difficulty]);

  const currentQuestion = questions[currentQuestionIndex];
  const hasAnswered = currentQuestion && userAnswers[currentQuestion.id] !== undefined;

  const handleAnswer = async (answer: string) => {
    if (!currentQuestion) return;
    setUserAnswers({ ...userAnswers, [currentQuestion.id]: answer });
    setShowExplanation(false);

    // For fill-in-blank questions, use tiered evaluation (exact → fuzzy → Claude API)
    if (currentQuestion.type === 'fill-in-blank') {
      // Don't evaluate empty answers
      if (!answer.trim()) return;

      setIsEvaluatingFillInBlank(true);
      try {
        const response = await fetch('/api/evaluate-writing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: currentQuestion.question,
            userAnswer: answer,
            correctAnswer: currentQuestion.correctAnswer,
            questionType: 'fill_in_blank',
            difficulty: currentQuestion.difficulty,
            acceptableVariations: currentQuestion.acceptableVariations || [],
            studyCodeId: studyCodeUuid
          })
        });

        if (!response.ok) {
          throw new Error('Evaluation failed');
        }

        const evaluationResult = await response.json();
        setEvaluationResults({
          ...evaluationResults,
          [currentQuestion.id]: evaluationResult
        });
        // Show explanation immediately after evaluation
        setShowExplanation(true);
      } catch (error) {
        console.error('❌ Error evaluating fill-in-blank answer:', error);
        console.error('Error details:', error instanceof Error ? error.message : String(error));

        // Fallback to simple exact match on error
        const isCorrect = answer === currentQuestion.correctAnswer;
        const evaluationResult: EvaluationResult = {
          isCorrect,
          score: isCorrect ? 100 : 0,
          hasCorrectAccents: true,
          feedback: isCorrect ? 'Correct!' : `The correct answer is: ${currentQuestion.correctAnswer}`,
          corrections: {},
          correctedAnswer: isCorrect ? undefined : currentQuestion.correctAnswer,
        };

        // Include metadata for superusers even in fallback
        if (isSuperuser) {
          evaluationResult.metadata = {
            difficulty: currentQuestion.difficulty,
            evaluationTier: 'exact_match',
            usedClaudeAPI: false,
            similarityScore: undefined,
            confidenceScore: undefined,
            confidenceThreshold: undefined,
            modelUsed: 'fallback_error'
          };
        }

        setEvaluationResults({
          ...evaluationResults,
          [currentQuestion.id]: evaluationResult
        });
        // Show explanation immediately after evaluation (even in error case)
        setShowExplanation(true);
      } finally {
        setIsEvaluatingFillInBlank(false);
      }
      return;
    }

    // For other non-writing questions (multiple-choice, true-false), use exact match
    if (currentQuestion.type !== 'writing') {
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
      if (isSuperuser) {
        evaluationResult.metadata = {
          difficulty: currentQuestion.difficulty,
          evaluationTier: 'exact_match',
          usedClaudeAPI: false,
          similarityScore: undefined,
          confidenceScore: undefined,
          confidenceThreshold: undefined,
          modelUsed: undefined,
        };
      }

      setEvaluationResults({
        ...evaluationResults,
        [currentQuestion.id]: evaluationResult
      });
    }
  };

  // Handler for writing question evaluation
  const handleWritingSubmit = (answer: string, evaluation: EvaluationResult) => {
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
    if (!FEATURES.PROGRESS_TRACKING) return;

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
            <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
              Quiz Complete! 🎉
            </h2>
            <p className="text-gray-600 dark:text-gray-300">{topic}</p>
          </div>

          <div className="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg p-8 text-white text-center mb-8">
            <div className="text-6xl font-bold mb-2">{score.percentage}%</div>
            <div className="text-xl">
              {score.correct} out of {score.total} correct
            </div>
          </div>

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
                  {isSuperuser && q.type === 'writing' && (
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
                  {isSuperuser && evaluation && evaluation.metadata && (
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
                              {evaluation.metadata.evaluationTier.replace(/_/g, ' ')}
                            </span>
                          </div>
                          {evaluation.metadata.similarityScore !== undefined && (
                            <div>
                              <span className="font-semibold text-purple-900 dark:text-purple-200">Similarity:</span>
                              <span className="ml-2 text-purple-800 dark:text-purple-300">{evaluation.metadata.similarityScore}%</span>
                            </div>
                          )}
                          {evaluation.metadata.confidenceScore !== undefined && (
                            <div>
                              <span className="font-semibold text-purple-900 dark:text-purple-200">Confidence:</span>
                              <span className="ml-2 text-purple-800 dark:text-purple-300">{evaluation.metadata.confidenceScore}%</span>
                            </div>
                          )}
                          {evaluation.metadata.confidenceThreshold !== undefined && (
                            <div>
                              <span className="font-semibold text-purple-900 dark:text-purple-200">Similarity Threshold:</span>
                              <span className="ml-2 text-purple-800 dark:text-purple-300">{evaluation.metadata.confidenceThreshold}%</span>
                            </div>
                          )}
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
                </div>
              );
            })}
          </div>

          {/* Study Guide Section */}
          {loadingStudyGuide && (
            <div className="mb-8 p-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <div className="flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
                <p className="text-blue-800 dark:text-blue-200">Generating your personalized study guide...</p>
              </div>
            </div>
          )}

          {!loadingStudyGuide && studyGuide.length > 0 && (
            <div className="mb-8">
              <div className="bg-gradient-to-r from-purple-500 to-indigo-600 rounded-lg p-6 text-white mb-4">
                <h3 className="text-2xl font-bold mb-2">📚 Study Guide</h3>
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
                    <div className="flex items-start justify-between mb-3">
                      <h4 className="text-xl font-bold text-gray-900 dark:text-white">
                        {recommendation.topic}
                      </h4>
                      <span className="px-3 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded-full text-sm font-semibold">
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
                              <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-purple-700 dark:group-hover:text-purple-300">
                                {resource.title || 'Video Resource'}
                              </span>
                              <svg
                                className="w-4 h-4 ml-auto text-gray-400 group-hover:text-purple-600"
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
            </div>
          )}

          {!loadingStudyGuide && studyGuide.length === 0 && score.percentage === 100 && (
            <div className="mb-8 p-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-center">
              <p className="text-xl font-bold text-green-800 dark:text-green-300">
                Perfect Score! 🎉
              </p>
              <p className="text-green-700 dark:text-green-400 mt-2">
                You've mastered this material. Keep up the excellent work!
              </p>
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

      {/* Render Writing Question Component for writing type */}
      {currentQuestion.type === 'writing' ? (
        <div className="space-y-6">
          <WritingQuestionComponent
            question={{
              id: currentQuestion.id,
              question_en: currentQuestion.question,
              correct_answer_fr: currentQuestion.correctAnswer,
              acceptable_variations: currentQuestion.acceptableVariations || [],
              topic: currentQuestion.topic,
              difficulty: currentQuestion.difficulty,
              question_type: currentQuestion.writingType || 'translation',
              explanation: currentQuestion.explanation || '',
              hints: currentQuestion.hints || [],
              unit_id: currentQuestion.unitId,
              requires_complete_sentence: currentQuestion.requiresCompleteSentence || false,
              created_at: new Date().toISOString()
            }}
            onSubmit={handleWritingSubmit}
            showHints={true}
            isSuperuser={isSuperuser}
            studyCodeUuid={studyCodeUuid}
          />

          {/* Navigation for writing questions */}
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
            {isSuperuser && !showExplanation && (
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
            {currentQuestion.type === 'fill-in-blank' ? (
              <div>
                <input
                  type="text"
                  value={userAnswers[currentQuestion.id] || ''}
                  onChange={(e) => {
                    // Only update state, don't evaluate yet
                    setUserAnswers({ ...userAnswers, [currentQuestion.id]: e.target.value });
                  }}
                  onKeyDown={(e) => {
                    // Evaluate when user presses Enter
                    if (e.key === 'Enter' && !isEvaluatingFillInBlank) {
                      handleAnswer(userAnswers[currentQuestion.id] || '');
                    }
                  }}
                  placeholder="Type your answer here..."
                  disabled={isEvaluatingFillInBlank}
                  className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                />
                {isEvaluatingFillInBlank && (
                  <p className="text-sm text-indigo-600 dark:text-indigo-400 mt-2 flex items-center gap-2">
                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Evaluating your answer...
                  </p>
                )}
                {!isEvaluatingFillInBlank && !showExplanation && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                    {(currentQuestion.question.match(/___+/g) || []).length > 1
                      ? 'Multiple blanks: type words separated by spaces. Press Enter to submit.'
                      : 'Press Enter to submit'}
                  </p>
                )}
              </div>
            ) : (
              currentQuestion.options?.map((option, idx) => {
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
              })
            )}
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
              {isSuperuser && (
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
              {isSuperuser && evaluationResults[currentQuestion.id]?.metadata && (() => {
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
                          {metadata.evaluationTier.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Similarity:</span>
                        <span className="ml-2 text-purple-800 dark:text-purple-300">
                          {metadata.similarityScore !== undefined
                            ? `${metadata.similarityScore}%`
                            : 'N/A'}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Confidence:</span>
                        <span className="ml-2 text-purple-800 dark:text-purple-300">
                          {metadata.confidenceScore !== undefined
                            ? `${metadata.confidenceScore}%`
                            : 'N/A'}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Similarity Threshold:</span>
                        <span className="ml-2 text-purple-800 dark:text-purple-300">
                          {metadata.confidenceThreshold !== undefined
                            ? `${metadata.confidenceThreshold}%`
                            : 'N/A'}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Used Claude API:</span>
                        <span className="ml-2 text-purple-800 dark:text-purple-300">
                          {metadata.usedClaudeAPI ? 'Yes' : 'No'}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Model:</span>
                        <span className="ml-2 text-purple-800 dark:text-purple-300">
                          {metadata.modelUsed || 'N/A'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          <div>
            {!showExplanation && hasAnswered && currentQuestion.type !== 'fill-in-blank' && (
              <button
                onClick={() => setShowExplanation(true)}
                className="w-full py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
              >
                Submit Answer
              </button>
            )}

            {showExplanation && (
              <div className="space-y-3">
                {isSuperuser && (
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
