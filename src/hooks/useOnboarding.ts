'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  isHomeTourComplete,
  setHomeTourComplete,
  isQuizTourComplete,
  setQuizTourComplete,
} from '@/lib/onboarding';

export function useOnboarding() {
  // Default true to prevent tour flash on hydration
  const [homeTourDone, setHomeTourDone] = useState(true);
  const [quizTourDone, setQuizTourDone] = useState(true);

  useEffect(() => {
    setHomeTourDone(isHomeTourComplete());
    setQuizTourDone(isQuizTourComplete());
  }, []);

  const completeHomeTour = useCallback(() => {
    setHomeTourComplete();
    setHomeTourDone(true);
  }, []);

  const completeQuizTour = useCallback(() => {
    setQuizTourComplete();
    setQuizTourDone(true);
  }, []);

  return {
    shouldShowHomeTour: !homeTourDone,
    completeHomeTour,
    shouldShowQuizTour: !quizTourDone,
    completeQuizTour,
  };
}
