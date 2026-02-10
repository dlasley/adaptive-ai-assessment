'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { units } from '@/lib/units';
import {
  getStoredStudyCode,
  storeStudyCode,
  clearStudyCode,
  verifyStudyCode,
  normalizeStudyCode,
  getSkipChoice,
  setSkipChoice,
} from '@/lib/study-codes';
import { StudyCodeDisplay } from '@/components/StudyCodeDisplay';
import { StudyCodeEntry } from '@/components/StudyCodeEntry';
import { QUIZ_MODES, QuizMode, getDefaultMode } from '@/lib/quiz-modes';
import { FEATURES } from '@/lib/feature-flags';
import LoadingSpinner from '@/components/LoadingSpinner';
import OnboardingTour from '@/components/OnboardingTour';
import TourButton from '@/components/TourButton';
import ContextualHint from '@/components/ContextualHint';
import { useOnboarding } from '@/hooks/useOnboarding';
import { Step } from 'react-joyride';

type Phase = 'resolving' | 'choosing' | 'ready';

export default function Home() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner />
      </div>
    }>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedUnit, setSelectedUnit] = useState<string>('all');
  const [numQuestions, setNumQuestions] = useState<number>(30);
  const [difficulty, setDifficulty] = useState<'beginner' | 'intermediate' | 'advanced'>('beginner');
  const [quizMode, setQuizMode] = useState<QuizMode>(getDefaultMode());
  const [adaptiveMode, setAdaptiveMode] = useState(FEATURES.LEITNER_MODE);
  const [studyCode, setStudyCode] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('resolving');
  const [existingCodeForSwap, setExistingCodeForSwap] = useState<string | null>(null);
  const [pendingUrlCode, setPendingUrlCode] = useState<string | null>(null);
  const hasResolved = useRef(false);
  const { shouldShowHomeTour, completeHomeTour } = useOnboarding();
  const [runTour, setRunTour] = useState(false);

  const homeTourSteps: Step[] = [
    {
      target: '#tour-study-code',
      content: 'This is your unique study code. It tracks your progress \u2014 save it or scan the QR on your phone!',
      disableBeacon: true,
    },
    {
      target: '#tour-unit-selector',
      content: 'Choose a specific unit to study, or leave it on "All Units" for a comprehensive review.',
    },
    {
      target: '#tour-num-questions',
      content: 'Pick how many questions you want. Start with 10 for a quick practice.',
    },
    {
      target: '#tour-quiz-mode',
      content: 'Practice Mode mixes all question types. Assessment Mode uses only written answers \u2014 just like a real test!',
    },
    {
      target: '#tour-difficulty',
      content: 'Beginner is great to start. Try Intermediate and Advanced as you improve.',
    },
    {
      target: '#tour-start-button',
      content: 'All set! Hit this button to start. Bonne chance!',
    },
  ];

  // Resolve study code on mount: check URL param, localStorage, or show choice screen
  useEffect(() => {
    if (hasResolved.current) return;
    hasResolved.current = true;

    const resolve = async () => {
      const paramCode = searchParams.get('code');
      const storedCode = getStoredStudyCode();
      const skipChoice = getSkipChoice();

      // 1. Handle ?code= URL parameter (from QR scan)
      if (paramCode) {
        const normalized = normalizeStudyCode(paramCode);
        const isValid = await verifyStudyCode(normalized);

        // Clean URL regardless
        router.replace('/', { scroll: false });

        if (isValid) {
          if (storedCode && storedCode !== normalized) {
            // Conflict: let StudyCodeEntry handle the swap warning
            setExistingCodeForSwap(storedCode);
            setPendingUrlCode(normalized);
            setPhase('choosing');
            return;
          }
          // No conflict - store and proceed
          storeStudyCode(normalized);
          setSkipChoice(skipChoice); // preserve existing preference
          setStudyCode(normalized);

          setPhase('ready');
          return;
        }
        // Invalid QR code - fall through
      }

      // 2. Check localStorage + skip preference
      if (storedCode && skipChoice) {
        const isValid = await verifyStudyCode(storedCode);
        if (isValid) {
          setStudyCode(storedCode);

          setPhase('ready');
          return;
        }
        // Stale code - clear everything
        clearStudyCode();
      }

      // 3. Has a stored code but no skip preference, or no code at all
      if (storedCode && !skipChoice) {
        setExistingCodeForSwap(storedCode);
      }
      setPhase('choosing');
    };

    resolve();
  }, [searchParams, router]);

  // Auto-start tour for first-time users
  useEffect(() => {
    if (phase === 'ready' && shouldShowHomeTour) {
      const timer = setTimeout(() => setRunTour(true), 800);
      return () => clearTimeout(timer);
    }
  }, [phase, shouldShowHomeTour]);

  const handleStartPractice = () => {
    const params = new URLSearchParams({
      num: numQuestions.toString(),
      difficulty,
      mode: quizMode,
    });
    if (adaptiveMode) {
      params.set('adaptive', 'true');
    }
    router.push(`/quiz/${selectedUnit}?${params.toString()}`);
  };

  const modeConfig = QUIZ_MODES[quizMode];


  const selectedUnitData = units.find(u => u.id === selectedUnit);

  // Phase: resolving - show loading spinner
  if (phase === 'resolving') {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner />
      </div>
    );
  }

  // Phase: choosing - show the entry/choice component
  if (phase === 'choosing') {
    return (
      <div className="space-y-8">
        <div className="text-center">
          <h2 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
            Practice French
          </h2>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            AI-generated questions from all your course materials
          </p>
        </div>
        <StudyCodeEntry
          onCodeEstablished={(code) => {
            setStudyCode(code);
            setPhase('ready');
          }}
          existingCode={existingCodeForSwap}
          pendingCode={pendingUrlCode}
        />
      </div>
    );
  }

  // Phase: ready - show study code + quiz configuration
  return (
    <div className="space-y-8">
      <OnboardingTour
        steps={homeTourSteps}
        run={runTour}
        onComplete={() => {
          completeHomeTour();
          setRunTour(false);
        }}
      />
      <div className="text-center">
        <h2 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
          Practice French
        </h2>
        <p className="text-lg text-gray-600 dark:text-gray-300">
          AI-generated questions from all your course materials
        </p>
      </div>

      {/* Study Code Card with QR - always shown */}
      {studyCode && (
        <div id="tour-study-code" className="max-w-3xl mx-auto">
          <StudyCodeDisplay
            studyCode={studyCode}
            size="medium"
            showActions={false}
            onSwitchCode={() => {
              setExistingCodeForSwap(studyCode);
              setPendingUrlCode(null);
              setPhase('choosing');
            }}
          />
        </div>
      )}

      {/* Main Practice Configuration Card */}
      <div className="max-w-3xl mx-auto bg-white dark:bg-gray-800 rounded-xl shadow-xl p-8 space-y-6">
        {/* Unit Selection */}
        <div className="flex items-center justify-between mb-2">
          <TourButton onClick={() => setRunTour(true)} />
        </div>
        <div id="tour-unit-selector">
          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Select Unit (Optional):
          </label>
          <select
            value={selectedUnit}
            onChange={(e) => setSelectedUnit(e.target.value)}
            className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white text-lg"
          >
            <option value="all">🌟 All Units (Recommended)</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.title}{unit.label ? `: ${unit.label}` : ''}
              </option>
            ))}
          </select>
          {selectedUnit === 'all' ? (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Practice with questions from all units for comprehensive review
            </p>
          ) : (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {selectedUnitData?.description}
            </p>
          )}
        </div>

        {/* Number of Questions */}
        <div id="tour-num-questions">
          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Number of Questions:
          </label>
          <div className="grid grid-cols-5 gap-3">
            {[10, 20, 30, 40, 50].map((num) => (
              <button
                key={num}
                onClick={() => setNumQuestions(num)}
                className={`py-3 px-4 rounded-lg border-2 transition-all font-medium ${
                  numQuestions === num
                    ? 'border-indigo-600 bg-indigo-600 text-white shadow-lg'
                    : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-indigo-400 hover:shadow'
                }`}
              >
                {num}
              </button>
            ))}
          </div>
        </div>

        {/* Quiz Mode Selection */}
        <ContextualHint
          id="hint-assessment-mode"
          message="Tip: Assessment Mode uses only written responses &mdash; great for exam prep!"
        >
        <div id="tour-quiz-mode">
          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Quiz Mode:
          </label>
          <div className="grid grid-cols-2 gap-3">
            {(Object.keys(QUIZ_MODES) as QuizMode[]).map((mode) => {
              const config = QUIZ_MODES[mode];
              const isSelected = quizMode === mode;
              return (
                <button
                  key={mode}
                  onClick={() => setQuizMode(mode)}
                  className={`py-4 px-4 rounded-lg border-2 transition-all text-left ${
                    isSelected
                      ? mode === 'assessment'
                        ? 'border-amber-600 bg-amber-600 text-white shadow-lg'
                        : 'border-indigo-600 bg-indigo-600 text-white shadow-lg'
                      : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-indigo-400 hover:shadow'
                  }`}
                >
                  <div className="font-semibold">
                    {mode === 'practice' ? '📚 ' : '📝 '}
                    {config.label}
                  </div>
                  <div className={`text-xs mt-1 ${isSelected ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`}>
                    {config.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        </ContextualHint>

        {/* Adaptive Mode Toggle */}
        {FEATURES.LEITNER_MODE && studyCode && (
          <div className="flex items-center justify-between p-4 rounded-lg border-2 border-gray-200 dark:border-gray-600">
            <div>
              <div className="font-semibold text-gray-900 dark:text-white">
                Adaptive Mode
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Prioritize questions you&apos;ve struggled with
              </div>
            </div>
            <button
              onClick={() => setAdaptiveMode(!adaptiveMode)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                adaptiveMode ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  adaptiveMode ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        )}

        {/* Difficulty Selection */}
        <div id="tour-difficulty">
          <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Difficulty Level:
          </label>
          <div className="grid grid-cols-3 gap-3">
            {(['beginner', 'intermediate', 'advanced'] as const).map((level) => (
              <button
                key={level}
                onClick={() => setDifficulty(level)}
                className={`py-3 px-4 rounded-lg border-2 transition-all capitalize font-medium ${
                  difficulty === level
                    ? 'border-indigo-600 bg-indigo-600 text-white shadow-lg'
                    : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-indigo-400 hover:shadow'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </div>

        {/* Start Button */}
        <button
          id="tour-start-button"
          onClick={handleStartPractice}
          className={`w-full py-5 rounded-lg font-bold text-xl text-white shadow-lg hover:shadow-xl transition-all transform hover:-translate-y-0.5 ${
            quizMode === 'assessment'
              ? 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700'
              : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700'
          }`}
        >
          {quizMode === 'assessment' ? '📝 Start Assessment' : '🚀 Start Practice Session'}
        </button>
      </div>
{/*
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 text-center">
          <div className="text-4xl mb-3">📚</div>
          <h3 className="font-bold text-gray-900 dark:text-white mb-2">1,000+ Questions</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Comprehensive question bank covering all units
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 text-center">
          <div className="text-4xl mb-3">🎯</div>
          <h3 className="font-bold text-gray-900 dark:text-white mb-2">Instant Feedback</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Get explanations for every answer
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 text-center">
          <div className="text-4xl mb-3">📊</div>
          <h3 className="font-bold text-gray-900 dark:text-white mb-2">Track Progress</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            See your scores and review mistakes
          </p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto">
        <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-4 text-center">
          Or Browse by Unit
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {units.map((unit) => (
            <button
              key={unit.id}
              onClick={() => {
                setSelectedUnit(unit.id);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="group text-left bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-xl transition-all p-5 border-2 border-transparent hover:border-indigo-500"
            >
              <h4 className="font-bold text-gray-900 dark:text-white mb-2 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                {unit.title}
              </h4>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
                {unit.description}
              </p>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {unit.topics.length} topics available
              </div>
            </button>
          ))}
        </div>
      </div>
*/}
      {/* How it Works */}
      <div className="max-w-4xl mx-auto bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-gray-800 dark:to-gray-700 rounded-lg p-8">
        <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-6 text-center">
          How It Works
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="text-center">
            <div className="w-12 h-12 bg-indigo-600 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-white font-bold text-xl">1</span>
            </div>
            <h4 className="font-semibold text-gray-900 dark:text-white mb-2">Configure</h4>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Choose unit, number of questions, and difficulty
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-purple-600 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-white font-bold text-xl">2</span>
            </div>
            <h4 className="font-semibold text-gray-900 dark:text-white mb-2">Practice</h4>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Answer questions with instant feedback
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-pink-600 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-white font-bold text-xl">3</span>
            </div>
            <h4 className="font-semibold text-gray-900 dark:text-white mb-2">Review</h4>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              See your score and learn from explanations
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
