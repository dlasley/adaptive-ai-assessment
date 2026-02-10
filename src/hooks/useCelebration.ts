'use client';

import { useState, useCallback, useRef } from 'react';
import { detectMilestones, MilestoneDetectionInput, MilestoneResult } from '@/lib/milestone-detection';
import { soundGenerator } from '@/lib/sound-effects';
import { isAnimationsEnabled } from '@/lib/celebration-settings';
import confetti from 'canvas-confetti';

const STREAK_MILESTONES = [3, 5, 10];
const STREAK_LABELS: Record<number, { msg: string; icon: string }> = {
  3: { msg: '3x Streak!', icon: '\u26A1' },
  5: { msg: '5x Streak!', icon: '\uD83D\uDD25' },
  10: { msg: '10x Streak! On Fire!', icon: '\uD83D\uDD25\uD83D\uDD25' },
};

export function useCelebration() {
  const [milestones, setMilestones] = useState<MilestoneResult | null>(null);
  const [currentStreak, setCurrentStreak] = useState(0);
  const [showOverlay, setShowOverlay] = useState(false);
  const [streakToast, setStreakToast] = useState<{ msg: string; icon: string } | null>(null);
  const streakRef = useRef(0);
  const streakTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recordAnswer = useCallback((isCorrect: boolean) => {
    if (isCorrect) {
      streakRef.current += 1;
      setCurrentStreak(streakRef.current);

      // Check streak milestones
      if (STREAK_MILESTONES.includes(streakRef.current)) {
        const label = STREAK_LABELS[streakRef.current];
        setStreakToast(label);
        soundGenerator.playStreakChime();

        if (streakTimeoutRef.current) clearTimeout(streakTimeoutRef.current);
        streakTimeoutRef.current = setTimeout(() => setStreakToast(null), 2500);
      }
    } else {
      streakRef.current = 0;
      setCurrentStreak(0);
    }
  }, []);

  const detectAndCelebrate = useCallback(async (input: MilestoneDetectionInput) => {
    const result = detectMilestones(input);
    setMilestones(result);

    if (!isAnimationsEnabled()) return;

    // Fire confetti for perfect score
    if (result.isPerfectScore) {
      const colors = result.isAssessmentMode
        ? ['#F59E0B', '#D97706', '#FBBF24', '#FDE68A']
        : ['#4F46E5', '#7C3AED', '#EC4899', '#F59E0B', '#10B981'];
      confetti({
        particleCount: result.isAssessmentMode ? 150 : 100,
        spread: result.isAssessmentMode ? 100 : 70,
        origin: { y: 0.6 },
        colors,
      });
      soundGenerator.playChime();
    } else if (result.isNewOverallHighScore || result.isNewHighScore) {
      soundGenerator.playFanfare();
      // Firework confetti: launch trail then explosion burst
      const colors = result.isNewOverallHighScore
        ? ['#F59E0B', '#FBBF24', '#FDE68A', '#EC4899', '#7C3AED']
        : ['#4F46E5', '#7C3AED', '#EC4899', '#F59E0B', '#10B981'];
      // Launch trail from bottom
      confetti({
        particleCount: 15,
        angle: 90,
        spread: 8,
        origin: { x: 0.5, y: 1 },
        startVelocity: 45,
        gravity: 0.8,
        ticks: 80,
        colors: ['#FFD700', '#FFA500'],
        shapes: ['circle'],
      });
      // Explosion burst at top (timed to whistle peak ~430ms)
      setTimeout(() => {
        confetti({
          particleCount: 120,
          spread: 100,
          origin: { x: 0.5, y: 0.3 },
          startVelocity: 30,
          gravity: 0.6,
          ticks: 200,
          colors,
        });
      }, 430);
    }

    setShowOverlay(true);
  }, []);

  const dismissOverlay = useCallback(() => {
    setShowOverlay(false);
  }, []);

  const dismissStreakToast = useCallback(() => {
    setStreakToast(null);
    if (streakTimeoutRef.current) clearTimeout(streakTimeoutRef.current);
  }, []);

  return {
    milestones,
    currentStreak,
    showOverlay,
    streakToast,
    recordAnswer,
    detectAndCelebrate,
    dismissOverlay,
    dismissStreakToast,
  };
}
