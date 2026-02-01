'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getStoredStudyCode, getQuizHistory, getConceptMastery, getWeakTopics, getStudyCodeDetails } from '@/lib/study-codes';
import { getProgress } from '@/lib/progress-tracking';
import type { StudyCode, QuizHistory, ConceptMastery } from '@/lib/supabase';

export default function ProgressPage() {
  const router = useRouter();
  const [studyCode, setStudyCode] = useState<string | null>(null);
  const [studyCodeDetails, setStudyCodeDetails] = useState<StudyCode | null>(null);
  const [progress, setProgress] = useState<any>(null);
  const [quizHistory, setQuizHistory] = useState<QuizHistory[]>([]);
  const [conceptMastery, setConceptMastery] = useState<ConceptMastery[]>([]);
  const [weakTopics, setWeakTopics] = useState<ConceptMastery[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCopied, setShowCopied] = useState(false);

  useEffect(() => {
    const loadProgress = async () => {
      const code = getStoredStudyCode();

      if (!code) {
        // No study code, redirect to home
        router.push('/');
        return;
      }

      setStudyCode(code);
      setLoading(true);

      try {
        // Load all progress data
        const [details, prog, history, mastery, weak] = await Promise.all([
          getStudyCodeDetails(code),
          getProgress(code),
          getQuizHistory(code),
          getConceptMastery(code),
          getWeakTopics(code),
        ]);

        setStudyCodeDetails(details);
        setProgress(prog);
        setQuizHistory(history);
        setConceptMastery(mastery);
        setWeakTopics(weak);
      } catch (error) {
        console.error('Error loading progress:', error);
      } finally {
        setLoading(false);
      }
    };

    loadProgress();
  }, [router]);

  const handleCopyCode = () => {
    if (studyCode) {
      navigator.clipboard.writeText(studyCode);
      setShowCopied(true);
      setTimeout(() => setShowCopied(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-300">Loading your progress...</p>
        </div>
      </div>
    );
  }

  if (!studyCode) {
    return (
      <div className="text-center py-12">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">No Study Code Found</h2>
        <p className="text-gray-600 dark:text-gray-300 mb-6">
          You need a study code to track your progress.
        </p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
        >
          Go to Home
        </button>
      </div>
    );
  }

  const overallAccuracy = progress?.overallAccuracy || 0;
  const totalQuizzes = progress?.totalQuizzes || 0;
  const totalQuestions = progress?.totalQuestions || 0;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
          📊 Your Progress
        </h1>
        <p className="text-lg text-gray-600 dark:text-gray-300">
          Track your learning journey
        </p>
      </div>

      {/* Study Code Card */}
      <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-gray-800 dark:to-gray-700 rounded-xl shadow-lg p-6 border-2 border-indigo-200 dark:border-indigo-800">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Your Study Code
            </h3>
            <code className="text-2xl font-mono font-bold text-indigo-600 dark:text-indigo-400 bg-white dark:bg-gray-900 px-4 py-2 rounded-lg inline-block">
              {studyCode}
            </code>
          </div>
          <button
            onClick={handleCopyCode}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
          >
            {showCopied ? '✓ Copied!' : '📋 Copy'}
          </button>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-3">
          Use this code to access your progress from any device or share your progress with others.
        </p>
      </div>

      {/* Overall Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 text-center">
          <div className="text-4xl font-bold text-indigo-600 dark:text-indigo-400 mb-2">
            {totalQuizzes}
          </div>
          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Quizzes Completed
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 text-center">
          <div className="text-4xl font-bold text-purple-600 dark:text-purple-400 mb-2">
            {totalQuestions}
          </div>
          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Questions Answered
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 text-center">
          <div className="text-4xl font-bold text-green-600 dark:text-green-400 mb-2">
            {progress?.correctAnswers || 0}
          </div>
          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Correct Answers
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 text-center">
          <div className={`text-4xl font-bold mb-2 ${
            overallAccuracy >= 80 ? 'text-green-600 dark:text-green-400' :
            overallAccuracy >= 60 ? 'text-yellow-600 dark:text-yellow-400' :
            'text-red-600 dark:text-red-400'
          }`}>
            {overallAccuracy.toFixed(0)}%
          </div>
          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Overall Accuracy
          </div>
        </div>
      </div>

      {/* Quiz History */}
      {quizHistory.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            📚 Recent Quizzes
          </h2>
          <div className="space-y-3">
            {quizHistory.map((quiz) => (
              <div
                key={quiz.id}
                className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700 rounded-lg"
              >
                <div className="flex-1">
                  <div className="font-semibold text-gray-900 dark:text-white">
                    {quiz.unit_id === 'all' ? 'All Units' : `Unit: ${quiz.unit_id}`}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    {quiz.difficulty.charAt(0).toUpperCase() + quiz.difficulty.slice(1)} • {quiz.total_questions} questions • {new Date(quiz.quiz_date).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-2xl font-bold ${
                    quiz.score_percentage >= 80 ? 'text-green-600 dark:text-green-400' :
                    quiz.score_percentage >= 60 ? 'text-yellow-600 dark:text-yellow-400' :
                    'text-red-600 dark:text-red-400'
                  }`}>
                    {quiz.score_percentage.toFixed(0)}%
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    {quiz.correct_answers}/{quiz.total_questions}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Concept Mastery */}
      {conceptMastery.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            🎯 Topic Mastery
          </h2>
          <div className="space-y-3">
            {conceptMastery.map((concept) => (
              <div key={concept.topic} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-gray-900 dark:text-white">
                    {concept.topic}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {concept.correct_attempts}/{concept.total_attempts}
                    </span>
                    <span className={`font-bold ${
                      concept.mastery_percentage >= 85 ? 'text-green-600 dark:text-green-400' :
                      concept.mastery_percentage >= 70 ? 'text-yellow-600 dark:text-yellow-400' :
                      'text-red-600 dark:text-red-400'
                    }`}>
                      {concept.mastery_percentage.toFixed(0)}%
                    </span>
                  </div>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      concept.mastery_percentage >= 85 ? 'bg-green-600' :
                      concept.mastery_percentage >= 70 ? 'bg-yellow-600' :
                      'bg-red-600'
                    }`}
                    style={{ width: `${concept.mastery_percentage}%` }}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Weak Topics */}
      {weakTopics.length > 0 && (
        <div className="bg-orange-50 dark:bg-orange-900/20 border-2 border-orange-200 dark:border-orange-800 rounded-xl shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
            ⚠️ Topics to Practice
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            These topics need more practice (below 70% accuracy)
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {weakTopics.map((topic) => (
              <div key={topic.topic} className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-orange-200 dark:border-orange-800">
                <div className="font-semibold text-gray-900 dark:text-white mb-1">
                  {topic.topic}
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {topic.mastery_percentage.toFixed(0)}% accuracy • {topic.total_attempts} attempts
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No Data Message */}
      {totalQuizzes === 0 && (
        <div className="text-center py-12 bg-gray-50 dark:bg-gray-800 rounded-xl">
          <div className="text-6xl mb-4">📝</div>
          <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            No Quizzes Yet
          </h3>
          <p className="text-gray-600 dark:text-gray-300 mb-6">
            Take your first quiz to start tracking your progress!
          </p>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
          >
            Start Practicing
          </button>
        </div>
      )}

      {/* Back Button */}
      <div className="text-center">
        <button
          onClick={() => router.push('/')}
          className="px-6 py-3 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors font-medium"
        >
          ← Back to Home
        </button>
      </div>
    </div>
  );
}
