'use client';

import Joyride, { CallBackProps, STATUS, Step } from 'react-joyride';

interface OnboardingTourProps {
  steps: Step[];
  run: boolean;
  onComplete: () => void;
  continuous?: boolean;
}

export default function OnboardingTour({
  steps,
  run,
  onComplete,
  continuous = true,
}: OnboardingTourProps) {
  const handleCallback = (data: CallBackProps) => {
    const { status } = data;
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      onComplete();
    }
  };

  return (
    <Joyride
      steps={steps}
      run={run}
      continuous={continuous}
      disableOverlayClose
      showSkipButton
      showProgress
      callback={handleCallback}
      locale={{
        back: 'Back',
        close: 'Close',
        last: 'Got it!',
        next: 'Next',
        skip: 'Skip tour',
      }}
      styles={{
        options: {
          primaryColor: '#4f46e5',
          zIndex: 10000,
        },
        tooltip: {
          borderRadius: '12px',
          fontSize: '15px',
        },
        buttonNext: {
          borderRadius: '8px',
          padding: '8px 16px',
        },
        buttonBack: {
          color: '#6b7280',
        },
        buttonSkip: {
          color: '#9ca3af',
        },
      }}
    />
  );
}
