'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import { Question } from '@/types';
import { units } from '@/lib/units';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);
  const [studyGuide, setStudyGuide] = useState<TopicRecommendation[]>([]);
  const [loadingStudyGuide, setLoadingStudyGuide] = useState(false);

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

  const handleAnswer = (answer: string) => {
    if (!currentQuestion) return;
    setUserAnswers({ ...userAnswers, [currentQuestion.id]: answer });
    setShowExplanation(false);
  };

  const fetchStudyGuide = async () => {
    setLoadingStudyGuide(true);
    try {
      const incorrectQuestions = questions
        .filter((q) => userAnswers[q.id] !== q.correctAnswer)
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

  const handleNext = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      setShowExplanation(false);
    } else {
      setShowResults(true);
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
      if (userAnswers[q.id] === q.correctAnswer) {
        correct++;
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
              const isCorrect = userAnswer === q.correctAnswer;
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
                    <span className="text-2xl">{isCorrect ? '✅' : '❌'}</span>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-1">
                    Your answer: <span className="font-semibold">{userAnswer || 'Not answered'}</span>
                  </p>
                  {!isCorrect && (
                    <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                      Correct answer: <span className="font-semibold text-green-700 dark:text-green-400">{q.correctAnswer}</span>
                    </p>
                  )}
                  {q.explanation && (
                    <p className="text-sm text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 p-3 rounded mt-2">
                      💡 {q.explanation}
                    </p>
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
        </div>

        <div className="space-y-3 mb-8">
          {currentQuestion.type === 'fill-in-blank' ? (
            <div>
              <input
                type="text"
                value={userAnswers[currentQuestion.id] || ''}
                onChange={(e) => handleAnswer(e.target.value)}
                placeholder="Type your answer here..."
                className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white"
              />
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
            <button
              onClick={handleNext}
              className="w-full py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
            >
              {currentQuestionIndex === questions.length - 1 ? 'Finish Quiz' : 'Next Question →'}
            </button>
          )}
        </div>
      </div>

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
