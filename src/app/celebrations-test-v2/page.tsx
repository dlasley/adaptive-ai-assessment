'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import confetti from 'canvas-confetti';
import { isSoundEnabled, setSoundEnabled } from '@/lib/celebration-settings';
import AnimatedScoreCounter from '@/components/AnimatedScoreCounter';
import CelebrationOverlay from '@/components/CelebrationOverlay';
import MicroRewardToast from '@/components/MicroRewardToast';
import StatCard from '@/components/StatCard';
import type { MilestoneResult } from '@/lib/milestone-detection';

/** Preloads and plays WAV files from /public/sounds/ */
function useAudioFiles() {
  const cache = useRef<Record<string, AudioBuffer>>({});
  const ctxRef = useRef<AudioContext | null>(null);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    if (ctxRef.current.state === 'suspended') ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  // Preload all sounds on mount
  useEffect(() => {
    const files = ['chime', 'fanfare', 'pop', 'streak'];
    const ctx = getCtx();
    files.forEach(async (name) => {
      try {
        const resp = await fetch(`/sounds/${name}.wav`);
        const arrayBuf = await resp.arrayBuffer();
        cache.current[name] = await ctx.decodeAudioData(arrayBuf);
      } catch {
        // Silently skip if file not found
      }
    });
  }, [getCtx]);

  const play = useCallback(
    (name: string) => {
      if (!isSoundEnabled()) return;
      const buffer = cache.current[name];
      if (!buffer) return;
      try {
        const ctx = getCtx();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start();
      } catch {
        // Silently fail
      }
    },
    [getCtx],
  );

  return { play };
}

function TestCard({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl shadow-md p-6 space-y-3">
      <h3 className="font-bold text-lg text-gray-900">{label}</h3>
      <p className="text-sm text-gray-500">
        <span className="font-medium">Triggered when:</span> {trigger}
      </p>
      {children}
    </div>
  );
}

export default function CelebrationsTestV2Page() {
  const [soundOn, setSoundOn] = useState(() =>
    typeof window !== 'undefined' ? isSoundEnabled() : true,
  );
  const [scoreKey, setScoreKey] = useState(0);
  const [overlay, setOverlay] = useState<MilestoneResult | null>(null);
  const [toast, setToast] = useState<{ msg: string; icon: string } | null>(null);
  const [badges, setBadges] = useState<Record<string, boolean>>({});

  const { play } = useAudioFiles();

  const toggleSound = () => {
    const newValue = !soundOn;
    setSoundOn(newValue);
    setSoundEnabled(newValue);
  };

  const showBadge = (id: string) => {
    setBadges((prev) => ({ ...prev, [id]: false }));
    requestAnimationFrame(() => {
      setBadges((prev) => ({ ...prev, [id]: true }));
    });
  };

  const dismissOverlay = useCallback(() => setOverlay(null), []);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Celebrations Test v2</h1>
          <p className="text-sm text-indigo-600 font-medium mt-1">
            Pre-rendered WAV files (FM synthesis + reverb)
          </p>
        </div>
        <button
          onClick={toggleSound}
          className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
            soundOn
              ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
          }`}
        >
          Sound: {soundOn ? 'ON' : 'OFF'}
        </button>
      </div>

      <p className="text-gray-600 text-sm">
        This page uses pre-rendered WAV audio files instead of real-time Web Audio
        API synthesis. Compare with{' '}
        <a href="/celebrations-test" className="text-indigo-600 underline">
          v1 (synthesized)
        </a>
        .
      </p>

      {/* 1. Score Counter */}
      <TestCard
        label="Score Counter"
        trigger="Every quiz completion — score counts up from 0"
      >
        <div className="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg p-6 text-white text-center">
          <AnimatedScoreCounter
            key={scoreKey}
            target={87}
            className="text-5xl font-bold"
          />
        </div>
        <button
          onClick={() => setScoreKey((k) => k + 1)}
          className="w-full py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
        >
          Replay
        </button>
      </TestCard>

      {/* 2. Perfect Score */}
      <TestCard
        label="Perfect Score"
        trigger="You score 100% on any quiz"
      >
        <button
          onClick={() => {
            confetti({
              particleCount: 100,
              spread: 70,
              origin: { y: 0.6 },
              colors: ['#4F46E5', '#7C3AED', '#EC4899', '#F59E0B', '#10B981'],
            });
            play('chime');
          }}
          className="w-full py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
        >
          Fire Confetti + Chime
        </button>
      </TestCard>

      {/* 3. Assessment Ace */}
      <TestCard
        label="Assessment Ace"
        trigger="You score 100% on an assessment (written-only mode)"
      >
        <button
          onClick={() => {
            confetti({
              particleCount: 150,
              spread: 100,
              origin: { y: 0.6 },
              colors: ['#F59E0B', '#D97706', '#FBBF24', '#FDE68A'],
            });
            play('chime');
            showBadge('ace');
          }}
          className="w-full py-2 bg-amber-500 text-white rounded-lg font-medium hover:bg-amber-600 transition-colors"
        >
          Fire Gold Confetti + Chime
        </button>
        {badges['ace'] && (
          <div className="animate-badge-pop text-center">
            <span className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-amber-400 to-yellow-500 text-amber-900 rounded-full font-bold text-lg shadow-lg">
              &#127942; Assessment Ace!
            </span>
          </div>
        )}
      </TestCard>

      {/* 4. New High Score */}
      <TestCard
        label="New High Score"
        trigger="You beat your previous best for a unit + difficulty combo"
      >
        <button
          onClick={() => {
            play('fanfare');
            confetti({
              particleCount: 15, angle: 90, spread: 8,
              origin: { x: 0.5, y: 1 }, startVelocity: 45,
              gravity: 0.8, ticks: 80,
              colors: ['#FFD700', '#FFA500'], shapes: ['circle'],
            });
            setTimeout(() => {
              confetti({
                particleCount: 120, spread: 100,
                origin: { x: 0.5, y: 0.3 }, startVelocity: 30,
                gravity: 0.6, ticks: 200,
                colors: ['#4F46E5', '#7C3AED', '#EC4899', '#F59E0B', '#10B981'],
              });
            }, 430);
            showBadge('high');
          }}
          className="w-full py-2 bg-yellow-500 text-yellow-900 rounded-lg font-medium hover:bg-yellow-400 transition-colors"
        >
          Launch Firework
        </button>
        {badges['high'] && (
          <div className="animate-badge-pop text-center">
            <span className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-yellow-400 to-amber-500 text-yellow-900 rounded-full font-bold text-lg shadow-lg">
              &#11088; New Best!
            </span>
          </div>
        )}
      </TestCard>

      {/* 5. All-Time High Score */}
      <TestCard
        label="All-Time High Score"
        trigger="You beat your highest score ever across all quizzes"
      >
        <button
          onClick={() => {
            play('fanfare');
            confetti({
              particleCount: 15, angle: 90, spread: 8,
              origin: { x: 0.5, y: 1 }, startVelocity: 45,
              gravity: 0.8, ticks: 80,
              colors: ['#FFD700', '#FFA500'], shapes: ['circle'],
            });
            setTimeout(() => {
              confetti({
                particleCount: 150, spread: 120,
                origin: { x: 0.5, y: 0.3 }, startVelocity: 35,
                gravity: 0.6, ticks: 250,
                colors: ['#F59E0B', '#FBBF24', '#FDE68A', '#EC4899', '#7C3AED'],
              });
            }, 430);
            showBadge('alltime');
          }}
          className="w-full py-2 bg-yellow-500 text-yellow-900 rounded-lg font-medium hover:bg-yellow-400 transition-colors"
        >
          Launch Firework
        </button>
        {badges['alltime'] && (
          <div className="animate-badge-pop text-center">
            <span className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-yellow-400 to-amber-500 text-yellow-900 rounded-full font-bold text-lg shadow-lg">
              &#11088; All-Time Best!
            </span>
          </div>
        )}
      </TestCard>

      {/* 6-8. Streak Toasts */}
      {[
        { n: 3, msg: '3x Streak!', icon: '\u26A1' },
        { n: 5, msg: '5x Streak!', icon: '\uD83D\uDD25' },
        { n: 10, msg: '10x Streak! On Fire!', icon: '\uD83D\uDD25\uD83D\uDD25' },
      ].map(({ n, msg, icon }) => (
        <TestCard
          key={n}
          label={`${n}x Streak`}
          trigger={`You answer ${n} questions correctly in a row during a quiz`}
        >
          <button
            onClick={() => {
              play('streak');
              setToast({ msg, icon });
            }}
            className="w-full py-2 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600 transition-colors"
          >
            Play Streak + Toast
          </button>
        </TestCard>
      ))}

      {/* 9. Quiz Milestone */}
      <TestCard
        label="Quiz Milestone (10)"
        trigger="You complete your 10th, 25th, 50th, or 100th quiz"
      >
        <button
          onClick={() => {
            play('fanfare');
            showBadge('quiz10');
          }}
          className="w-full py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors"
        >
          Play Fanfare + Badge
        </button>
        {badges['quiz10'] && (
          <div className="animate-badge-pop text-center">
            <span className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-emerald-400 to-teal-500 text-emerald-900 rounded-full font-bold text-lg shadow-lg">
              &#127919; 10 Quizzes!
            </span>
          </div>
        )}
      </TestCard>

      {/* 10. Accuracy Threshold */}
      <TestCard
        label="Accuracy 90%+"
        trigger="Your overall accuracy crosses 70%, 80%, or 90% for the first time"
      >
        <button
          onClick={() => {
            play('fanfare');
            showBadge('acc90');
          }}
          className="w-full py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
        >
          Play Fanfare + Badge
        </button>
        {badges['acc90'] && (
          <div className="animate-badge-pop text-center">
            <span className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-blue-400 to-cyan-500 text-blue-900 rounded-full font-bold text-lg shadow-lg">
              &#128200; 90% Accuracy!
            </span>
          </div>
        )}
      </TestCard>

      {/* 11. Stat Card Glow */}
      <TestCard
        label="Stat Card Glow"
        trigger="Your overall accuracy is 90% or higher on the Progress page"
      >
        <div className="flex justify-center">
          <div className="w-48">
            <StatCard
              value="94%"
              label="Overall Accuracy"
              colorClass="text-green-600"
              size="lg"
              animate="glow"
            />
          </div>
        </div>
      </TestCard>

      {/* 12. Mastery Shimmer */}
      <TestCard
        label="Mastery Shimmer"
        trigger="A topic reaches 100% mastery on the Progress page"
      >
        <div className="space-y-2">
          <div className="flex justify-between text-sm text-gray-700">
            <span>Greetings & Introductions</span>
            <span className="font-bold text-green-600">100%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="h-2 rounded-full animate-shimmer bg-gradient-to-r from-green-500 via-green-300 to-green-500 bg-[length:200%_100%]"
              style={{ width: '100%' }}
            />
          </div>
          <div className="flex justify-between text-sm text-gray-700 mt-4">
            <span>Verb Conjugation</span>
            <span className="font-bold text-yellow-600">72%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="h-2 rounded-full bg-yellow-500 transition-all"
              style={{ width: '72%' }}
            />
          </div>
        </div>
      </TestCard>

      {/* 13. Full Celebration */}
      <TestCard
        label="Full Celebration"
        trigger="All milestones fire at once (e.g., perfect score + new high score + 50th quiz)"
      >
        <button
          onClick={() => {
            setOverlay({
              isPerfectScore: true,
              isNewHighScore: true,
              isNewOverallHighScore: true,
              previousBest: 85,
              previousOverallBest: 92,
              isAssessmentMode: false,
              quizCountMilestone: 50,
              accuracyThresholdCrossed: 90,
            });
            confetti({
              particleCount: 100,
              spread: 70,
              origin: { y: 0.6 },
              colors: ['#4F46E5', '#7C3AED', '#EC4899', '#F59E0B', '#10B981'],
            });
            play('chime');
          }}
          className="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-bold hover:from-indigo-700 hover:to-purple-700 transition-colors"
        >
          Simulate Full Celebration
        </button>
      </TestCard>

      {/* 14. Sound-only comparison */}
      <TestCard
        label="Sound Comparison"
        trigger="A/B test: click each to hear the four sound effects side by side"
      >
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => play('chime')}
            className="py-2 bg-purple-100 text-purple-700 rounded-lg font-medium hover:bg-purple-200 transition-colors"
          >
            Chime
          </button>
          <button
            onClick={() => play('fanfare')}
            className="py-2 bg-yellow-100 text-yellow-700 rounded-lg font-medium hover:bg-yellow-200 transition-colors"
          >
            Fanfare
          </button>
          <button
            onClick={() => play('pop')}
            className="py-2 bg-green-100 text-green-700 rounded-lg font-medium hover:bg-green-200 transition-colors"
          >
            Pop
          </button>
          <button
            onClick={() => play('streak')}
            className="py-2 bg-orange-100 text-orange-700 rounded-lg font-medium hover:bg-orange-200 transition-colors"
          >
            Streak
          </button>
        </div>
      </TestCard>

      {/* Overlay */}
      {overlay && (
        <CelebrationOverlay milestones={overlay} onDismiss={dismissOverlay} />
      )}

      {/* Toast */}
      {toast && (
        <MicroRewardToast
          message={toast.msg}
          icon={toast.icon}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
