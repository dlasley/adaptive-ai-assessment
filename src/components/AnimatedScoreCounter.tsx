'use client';

import { useState, useEffect, useRef } from 'react';
import { isAnimationsEnabled } from '@/lib/celebration-settings';

interface AnimatedScoreCounterProps {
  target: number;
  duration?: number;
  className?: string;
  onComplete?: () => void;
}

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

export default function AnimatedScoreCounter({
  target,
  duration = 1500,
  className = '',
  onComplete,
}: AnimatedScoreCounterProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const frameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    if (!isAnimationsEnabled()) {
      setDisplayValue(target);
      onComplete?.();
      return;
    }

    completedRef.current = false;

    const animate = (timestamp: number) => {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutQuart(progress);

      setDisplayValue(Math.round(easedProgress * target));

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      } else if (!completedRef.current) {
        completedRef.current = true;
        onComplete?.();
      }
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration, onComplete]);

  return <span className={className}>{displayValue}%</span>;
}
