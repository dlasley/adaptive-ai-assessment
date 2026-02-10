'use client';

import { useState, useEffect, useRef } from 'react';
import type { MilestoneResult } from '@/lib/milestone-detection';

interface CelebrationOverlayProps {
  milestones: MilestoneResult;
  onDismiss: () => void;
}

interface Badge {
  text: string;
  emoji: string;
  colorClass: string;
}

export default function CelebrationOverlay({
  milestones,
  onDismiss,
}: CelebrationOverlayProps) {
  const [visibleBadges, setVisibleBadges] = useState<Badge[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const badges: { badge: Badge; delay: number }[] = [];

    // Perfect score badge
    if (milestones.isPerfectScore) {
      badges.push({
        badge: {
          text: milestones.isAssessmentMode ? 'Assessment Ace!' : 'Perfect!',
          emoji: milestones.isAssessmentMode ? '\uD83C\uDFC6' : '\uD83C\uDF1F',
          colorClass: milestones.isAssessmentMode
            ? 'bg-gradient-to-r from-amber-400 to-yellow-500 text-amber-900'
            : 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white',
        },
        delay: 300,
      });
    }

    // New high score badge
    if (milestones.isNewHighScore && !milestones.isPerfectScore) {
      badges.push({
        badge: {
          text: milestones.isNewOverallHighScore ? 'All-Time Best!' : 'New Best!',
          emoji: '\u2B50',
          colorClass: 'bg-gradient-to-r from-yellow-400 to-amber-500 text-yellow-900',
        },
        delay: badges.length > 0 ? 800 : 300,
      });
    }

    // Quiz count milestone
    if (milestones.quizCountMilestone) {
      badges.push({
        badge: {
          text: `${milestones.quizCountMilestone} Quizzes!`,
          emoji: '\uD83C\uDFAF',
          colorClass: 'bg-gradient-to-r from-emerald-400 to-teal-500 text-emerald-900',
        },
        delay: badges.length > 0 ? 1300 : 300,
      });
    }

    // Accuracy threshold
    if (milestones.accuracyThresholdCrossed) {
      badges.push({
        badge: {
          text: `${milestones.accuracyThresholdCrossed}% Accuracy!`,
          emoji: '\uD83D\uDCC8',
          colorClass: 'bg-gradient-to-r from-blue-400 to-cyan-500 text-blue-900',
        },
        delay: badges.length > 0 ? 1800 : 300,
      });
    }

    // No badges to show
    if (badges.length === 0) {
      onDismiss();
      return;
    }

    // Sequence badge reveals
    badges.forEach(({ badge, delay }) => {
      const timer = setTimeout(() => {
        setVisibleBadges((prev) => [...prev, badge]);
      }, delay);
      timersRef.current.push(timer);
    });

    // Auto-dismiss after all badges shown + 3s
    const lastDelay = badges[badges.length - 1].delay;
    const dismissTimer = setTimeout(onDismiss, lastDelay + 3000);
    timersRef.current.push(dismissTimer);

    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, [milestones, onDismiss]);

  if (visibleBadges.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center pointer-events-auto"
      onClick={onDismiss}
    >
      {/* Semi-transparent backdrop */}
      <div className="absolute inset-0 bg-black/20" />

      {/* Badges stack */}
      <div className="relative flex flex-col items-center gap-3 sm:gap-4 px-4">
        {visibleBadges.map((badge, i) => (
          <div
            key={i}
            className={`animate-badge-pop inline-flex items-center gap-2 sm:gap-3 px-5 sm:px-8 py-3 sm:py-4 rounded-full font-bold text-base sm:text-xl shadow-2xl ${badge.colorClass}`}
          >
            <span className="text-xl sm:text-2xl">{badge.emoji}</span>
            <span>{badge.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
