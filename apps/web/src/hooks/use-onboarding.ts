'use client';

import { useCallback } from 'react';
import {
  isHomeTourComplete,
  setHomeTourComplete,
  isQuizTourComplete,
  setQuizTourComplete,
} from '@/lib/onboarding';
import { useLocalStorageValue, notifyLocalStorageWrite } from '@/hooks/use-local-storage-value';

// The server snapshot defaults both tours to "done" so the tour never
// flashes on hydration; the real value (usually "not done") arrives on the
// first client render once localStorage is readable.
const TOUR_DONE_SERVER_SNAPSHOT = () => true;

export function useOnboarding() {
  const homeTourDone = useLocalStorageValue(isHomeTourComplete, TOUR_DONE_SERVER_SNAPSHOT);
  const quizTourDone = useLocalStorageValue(isQuizTourComplete, TOUR_DONE_SERVER_SNAPSHOT);

  const completeHomeTour = useCallback(() => {
    setHomeTourComplete();
    notifyLocalStorageWrite();
  }, []);

  const completeQuizTour = useCallback(() => {
    setQuizTourComplete();
    notifyLocalStorageWrite();
  }, []);

  return {
    shouldShowHomeTour: !homeTourDone,
    completeHomeTour,
    shouldShowQuizTour: !quizTourDone,
    completeQuizTour,
  };
}
