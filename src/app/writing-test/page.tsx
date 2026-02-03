'use client';

import { useState, useEffect } from 'react';
import TypedAnswerQuestion from '@/components/WritingQuestion';
import type { WritingQuestion } from '@/lib/writing-questions';
import type { Question } from '@/types';
import { getRandomWritingQuestions } from '@/lib/writing-questions';
import { useQuizProgress } from '@/hooks/useQuizProgress';
import { useVideoRecommendations } from '@/hooks/useVideoRecommendations';
import { calculateQuizStats } from '@/lib/quiz-utils';

// Convert WritingQuestion (database format) to Question (component format)
function toQuestion(wq: WritingQuestion): Question {
  return {
    id: wq.id,
    question: wq.question_en,
    type: 'writing',
    correctAnswer: wq.correct_answer_fr || '',
    explanation: wq.explanation,
    unitId: wq.unit_id || 'all',
    topic: wq.topic,
    difficulty: wq.difficulty,
    writingType: wq.question_type,
    acceptableVariations: wq.acceptable_variations,
    hints: wq.hints,
    requiresCompleteSentence: wq.requires_complete_sentence
  };
}

// Sample questions for testing (before database is populated)
const SAMPLE_QUESTIONS: WritingQuestion[] = [
  {
    id: '1',
    question_en: 'How do you say "hello" in French?',
    correct_answer_fr: 'bonjour',
    acceptable_variations: ['salut', 'allô'],
    topic: 'greetings',
    difficulty: 'beginner',
    question_type: 'translation',
    explanation: 'Basic French greeting',
    hints: ['This is the most common greeting in French', 'It starts with "b"'],
    unit_id: null,
    requires_complete_sentence: false,
    created_at: new Date().toISOString()
  },
  {
    id: '2',
    question_en: 'Conjugate the verb "être" (to be) in present tense, first person: I am',
    correct_answer_fr: 'je suis',
    acceptable_variations: ['Je suis'],
    topic: 'verb_conjugation:être',
    difficulty: 'beginner',
    question_type: 'conjugation',
    explanation: 'The verb être is one of the most important irregular verbs in French',
    hints: ['être is irregular', 'First person singular: je...'],
    unit_id: null,
    requires_complete_sentence: false,
    created_at: new Date().toISOString()
  },
  {
    id: '3',
    question_en: 'What are you going to do after school today?',
    correct_answer_fr: 'Je vais faire mes devoirs',
    acceptable_variations: [
      'Je vais rentrer chez moi',
      'Je vais jouer au foot',
      'Je vais regarder la télé'
    ],
    topic: 'daily_routine',
    difficulty: 'advanced',
    question_type: 'open_ended',
    explanation: 'Practice the near future tense (aller + infinitive) with personal expression',
    hints: [
      'Use "Je vais..." to express what you\'re going to do',
      'Follow "vais" with an infinitive verb',
      'Write a complete sentence'
    ],
    unit_id: null,
    requires_complete_sentence: true,
    created_at: new Date().toISOString()
  },
  {
    id: '4',
    question_en: 'Describe your favorite food in a complete sentence.',
    correct_answer_fr: 'Mon plat préféré est la pizza',
    acceptable_variations: [
      'J\'aime la pizza',
      'Ma nourriture préférée est le chocolat',
      'Je préfère les pâtes'
    ],
    topic: 'food',
    difficulty: 'intermediate',
    question_type: 'open_ended',
    explanation: 'Practice expressing preferences with complete sentences',
    hints: [
      'Use "Mon plat préféré est..." or "J\'aime..."',
      'Remember to use the article (le, la, les)',
      'Write a complete sentence'
    ],
    unit_id: null,
    requires_complete_sentence: true,
    created_at: new Date().toISOString()
  },
  {
    id: '5',
    question_en: 'How do you ask "What time is it?" in French?',
    correct_answer_fr: 'Quelle heure est-il?',
    acceptable_variations: [
      'Quelle heure est il',
      'Il est quelle heure?',
      'Tu as l\'heure?'
    ],
    topic: 'questions',
    difficulty: 'intermediate',
    question_type: 'question_formation',
    explanation: 'Learn to ask about time in French',
    hints: [
      'Use "Quelle heure..."',
      'Remember to invert the verb',
      'Don\'t forget the hyphen'
    ],
    unit_id: null,
    requires_complete_sentence: false,
    created_at: new Date().toISOString()
  }
];

export default function WritingTestPage() {
  const [questions, setQuestions] = useState<WritingQuestion[]>(SAMPLE_QUESTIONS);
  const [loading, setLoading] = useState(true);

  // Use custom hooks for quiz management
  const quiz = useQuizProgress(questions);
  const recommendedVideos = useVideoRecommendations({
    results: quiz.results,
    questions,
    getTopicFromQuestion: (q) => q.topic,
    maxVideos: 6
  });

  // Load questions from database on mount
  useEffect(() => {
    async function loadQuestions() {
      try {
        setLoading(true);
        const dbQuestions = await getRandomWritingQuestions(5);

        if (dbQuestions && dbQuestions.length > 0) {
          setQuestions(dbQuestions);
          console.log(`✅ Loaded ${dbQuestions.length} questions from database`);
        } else {
          console.log('ℹ️ No database questions available, using sample questions');
          setQuestions(SAMPLE_QUESTIONS);
        }
      } catch (error) {
        console.error('Error loading questions:', error);
        console.log('ℹ️ Falling back to sample questions');
        setQuestions(SAMPLE_QUESTIONS);
      } finally {
        setLoading(false);
      }
    }

    loadQuestions();
  }, []);

  const handleRestart = async () => {
    quiz.restart();

    // Reload questions
    setLoading(true);
    try {
      const dbQuestions = await getRandomWritingQuestions(5);
      if (dbQuestions && dbQuestions.length > 0) {
        setQuestions(dbQuestions);
      }
    } catch (error) {
      console.error('Error reloading questions:', error);
    } finally {
      setLoading(false);
    }
  };

  // Calculate stats using utility function
  const stats = calculateQuizStats(quiz.results);

  // Loading state
  if (loading) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
              <p className="text-gray-600 dark:text-gray-300">
                Loading writing questions...
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (quiz.showResults) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">
            📊 Writing Practice Results
          </h1>

          {/* Summary Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-lg p-4 text-center">
              <div className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">
                {stats.averageScore}%
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Average Score
              </div>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 text-center">
              <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                {stats.correctCount}/{stats.totalQuestions}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Correct Answers
              </div>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 text-center">
              <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                {stats.accentAccuracy}/{stats.totalQuestions}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Perfect Accents
              </div>
            </div>
          </div>

          {/* Detailed Results */}
          <div className="space-y-4 mb-8">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">
              Detailed Results
            </h2>
            {quiz.results.map((result, index) => (
              <div key={index} className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    Question {index + 1}: {result.question}
                  </h3>
                  <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                    result.evaluation.isCorrect
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                      : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                  }`}>
                    {result.evaluation.score}%
                  </span>
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  <strong>Your answer:</strong> {result.answer}
                </div>
                {result.evaluation.correctedAnswer && (
                  <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    <strong>Correction:</strong> {result.evaluation.correctedAnswer}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Video Resources Section */}
          {recommendedVideos.length > 0 && (
            <div className="mb-8">
              <div className="bg-gradient-to-r from-purple-500 to-indigo-600 rounded-lg p-6 text-white mb-4">
                <h3 className="text-2xl font-bold mb-2">📺 Recommended Videos</h3>
                <p className="text-purple-100">
                  Watch these videos to review and strengthen your French skills
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {recommendedVideos.map((video, idx) => (
                  <a
                    key={idx}
                    href={video.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-3 p-4 bg-white dark:bg-gray-800 border-2 border-purple-200 dark:border-purple-800 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors group"
                  >
                    <svg
                      className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path d="M10 0C4.477 0 0 4.477 0 10s4.477 10 10 10 10-4.477 10-10S15.523 0 10 0zm3.5 10.5l-5 3a.5.5 0 01-.75-.433v-6a.5.5 0 01.75-.433l5 3a.5.5 0 010 .866z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-gray-900 dark:text-white group-hover:text-purple-700 dark:group-hover:text-purple-300 mb-1">
                        {video.title}
                      </h4>
                      {video.difficulty && (
                        <span className="inline-block px-2 py-0.5 text-xs font-semibold rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                          {video.difficulty}
                        </span>
                      )}
                    </div>
                    <svg
                      className="w-5 h-5 text-gray-400 group-hover:text-purple-600 dark:group-hover:text-purple-400 flex-shrink-0"
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
          )}

          <button
            onClick={handleRestart}
            className="w-full py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-semibold"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
          ✍️ French Writing Practice
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Practice French writing with AI-powered feedback and evaluation
        </p>
        <div className="mt-4 flex items-center gap-4">
          <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className="bg-indigo-600 h-2 rounded-full transition-all"
              style={{ width: `${quiz.progress.percentage}%` }}
            />
          </div>
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {quiz.progress.current} / {quiz.progress.total}
          </span>
        </div>
      </div>

      {/* Question */}
      <TypedAnswerQuestion
        question={toQuestion(questions[quiz.currentQuestion])}
        onSubmit={(answer, evaluation) =>
          quiz.handleSubmit(answer, evaluation, questions[quiz.currentQuestion].question_en)
        }
        showHints={true}
      />

      {/* Navigation */}
      {quiz.canProceed && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <button
            onClick={quiz.nextQuestion}
            className="w-full py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-semibold"
          >
            {quiz.currentQuestion < questions.length - 1 ? 'Next Question →' : 'See Results'}
          </button>
        </div>
      )}

      {/* Info Box */}
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-6 border-2 border-blue-200 dark:border-blue-800">
        <h3 className="font-bold text-blue-900 dark:text-blue-300 mb-2">
          ℹ️ About This Test
        </h3>
        <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1">
          <li>• Questions are evaluated by Claude Opus 4.5 for maximum accuracy</li>
          <li>• Accent usage is tracked separately (you can get credit without perfect accents)</li>
          <li>• Open-ended questions accept any grammatically correct and contextually appropriate answer</li>
          <li>• Advanced questions require complete sentence responses</li>
          <li>• Each evaluation costs ~$0.015 (using Claude Opus 4.5)</li>
        </ul>
      </div>
    </div>
  );
}
