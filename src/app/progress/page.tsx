'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getStoredStudyCode, getQuizHistory, getConceptMastery, getWeakTopics, getStudyCodeDetails } from '@/lib/study-codes';
import { getProgress } from '@/lib/progress-tracking';
import { getResourcesForTopics } from '@/lib/learning-resources-client';
import { StudyCodeDisplay } from '@/components/StudyCodeDisplay';
import StatCard from '@/components/StatCard';
import ResourceCard from '@/components/ResourceCard';
import type { StudyCode, QuizHistory, ConceptMastery } from '@/lib/supabase';
import type { LearningResource } from '@/types';
import { getAccuracyColor, getMasteryColor, getMasteryBgColor } from '@/lib/color-utils';
import LoadingSpinner from '@/components/LoadingSpinner';
import ContextualHint from '@/components/ContextualHint';
import EmptyStateGuide from '@/components/EmptyStateGuide';

export default function ProgressPage() {
  const router = useRouter();
  const [studyCode, setStudyCode] = useState<string | null>(null);
  const [studyCodeDetails, setStudyCodeDetails] = useState<StudyCode | null>(null);
  const [progress, setProgress] = useState<any>(null);
  const [quizHistory, setQuizHistory] = useState<QuizHistory[]>([]);
  const [conceptMastery, setConceptMastery] = useState<ConceptMastery[]>([]);
  const [weakTopics, setWeakTopics] = useState<ConceptMastery[]>([]);
  const [topicResources, setTopicResources] = useState<Map<string, LearningResource[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'quizzes' | 'mastery' | 'practice'>('quizzes');

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

        // Load resources for weak topics
        if (weak.length > 0) {
          const weakTopicNames = weak.map(w => w.topic);
          const resources = await getResourcesForTopics(weakTopicNames);
          // Group by topic
          const grouped = new Map<string, LearningResource[]>();
          for (const r of resources) {
            const existing = grouped.get(r.topic) || [];
            existing.push(r);
            grouped.set(r.topic, existing);
          }
          setTopicResources(grouped);
        }
      } catch (error) {
        console.error('Error loading progress:', error);
      } finally {
        setLoading(false);
      }
    };

    loadProgress();
  }, [router]);


  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <LoadingSpinner className="mx-auto mb-4" />
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

      {/* Study Code Card with QR */}
      <StudyCodeDisplay
        studyCode={studyCode}
        size="medium"
        showActions={false}
        onSwitchCode={() => router.push('/')}
      />

      {/* Overall Stats */}
      <ContextualHint
        id="hint-progress-stats"
        message="These stats update after every quiz. Try to improve your accuracy over time!"
        position="above"
      >
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <StatCard value={totalQuizzes} label="Quizzes Completed" colorClass="text-indigo-600 dark:text-indigo-400" size="lg" />
          <StatCard value={totalQuestions} label="Questions Answered" colorClass="text-purple-600 dark:text-purple-400" size="lg" />
          <StatCard value={progress?.correctAnswers || 0} label="Correct Answers" colorClass="text-green-600 dark:text-green-400" size="lg" />
          <StatCard value={`${overallAccuracy.toFixed(0)}%`} label="Overall Accuracy" colorClass={getAccuracyColor(overallAccuracy)} size="lg" animate={overallAccuracy >= 90 ? 'glow' : 'none'} />
        </div>
      </ContextualHint>

      {/* Tab Navigation */}
      {totalQuizzes > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg overflow-hidden">
          <div className="flex border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setActiveTab('quizzes')}
              className={`flex-1 py-4 px-4 text-sm font-semibold transition-colors ${
                activeTab === 'quizzes'
                  ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              <span className="hidden sm:inline">Recent </span>Quizzes
              {quizHistory.length > 0 && (
                <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-gray-200 dark:bg-gray-600">
                  {quizHistory.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('mastery')}
              className={`flex-1 py-4 px-4 text-sm font-semibold transition-colors ${
                activeTab === 'mastery'
                  ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              <span className="hidden sm:inline">Topic </span>Mastery
              {conceptMastery.length > 0 && (
                <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-gray-200 dark:bg-gray-600">
                  {conceptMastery.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('practice')}
              className={`flex-1 py-4 px-4 text-sm font-semibold transition-colors ${
                activeTab === 'practice'
                  ? 'text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-600 dark:border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              <span className="hidden sm:inline">Topics to </span>Practice
              {weakTopics.length > 0 && (
                <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-orange-200 dark:bg-orange-600 text-orange-800 dark:text-orange-100">
                  {weakTopics.length}
                </span>
              )}
            </button>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {/* Recent Quizzes Tab */}
            {activeTab === 'quizzes' && (
              <>
                {quizHistory.length > 0 ? (
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
                          <div className={`text-2xl font-bold ${getAccuracyColor(quiz.score_percentage)}`}>
                            {quiz.score_percentage.toFixed(0)}%
                          </div>
                          <div className="text-xs text-gray-600 dark:text-gray-400">
                            {quiz.correct_answers}/{quiz.total_questions}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-gray-500 dark:text-gray-400 py-8">
                    No quiz history yet. Complete a quiz to see your results here.
                  </p>
                )}
              </>
            )}

            {/* Topic Mastery Tab */}
            {activeTab === 'mastery' && (
              <>
                {conceptMastery.length > 0 ? (
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
                            <span className={`font-bold ${getMasteryColor(concept.mastery_percentage)}`}>
                              {concept.mastery_percentage.toFixed(0)}%
                            </span>
                          </div>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-2">
                          <div
                            className={`h-2 rounded-full transition-all ${getMasteryBgColor(concept.mastery_percentage)}${concept.mastery_percentage === 100 ? ' animate-shimmer bg-gradient-to-r from-green-500 via-green-300 to-green-500 bg-[length:200%_100%]' : ''}`}
                            style={{ width: `${concept.mastery_percentage}%` }}
                          ></div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-gray-500 dark:text-gray-400 py-8">
                    No topic mastery data yet. Complete quizzes to track your progress by topic.
                  </p>
                )}
              </>
            )}

            {/* Topics to Practice Tab */}
            {activeTab === 'practice' && (
              <>
                {weakTopics.length > 0 ? (
                  <div className="space-y-6">
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      These topics need more practice (below 70% accuracy)
                    </p>
                    {weakTopics.map((topic) => {
                      const resources = topicResources.get(topic.topic) || [];
                      return (
                        <div key={topic.topic} className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-5 border border-orange-200 dark:border-orange-800">
                          <div className="flex items-center justify-between mb-3">
                            <div>
                              <div className="font-bold text-lg text-gray-900 dark:text-white mb-1">
                                {topic.topic}
                              </div>
                              <div className="text-sm text-gray-600 dark:text-gray-400">
                                {topic.mastery_percentage.toFixed(0)}% accuracy • {topic.total_attempts} attempts
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
                                {topic.mastery_percentage.toFixed(0)}%
                              </div>
                            </div>
                          </div>

                          {/* Recommended Resources */}
                          {resources.length > 0 && (
                            <div className="mt-4 pt-4 border-t border-orange-200 dark:border-orange-700">
                              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                                Recommended Resources
                              </h4>
                              <div className="space-y-2">
                                {resources.slice(0, 3).map((resource) => (
                                  <ResourceCard key={resource.id} resource={resource} variant="orange" />
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <p className="text-green-600 dark:text-green-400 font-semibold">
                      Great job! No weak topics detected.
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                      Keep practicing to maintain your mastery.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* No Data Message - only show when no quizzes at all */}
      {totalQuizzes === 0 && (
        <EmptyStateGuide onStartPractice={() => router.push('/')} />
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
