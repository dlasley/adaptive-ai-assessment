'use client';

interface LiveRegionProps {
  message: string;
}

/**
 * Visually hidden aria-live="polite" region for announcing state changes
 * (evaluation progress, answer correctness, quiz progress) to screen
 * reader users, who otherwise get no cue when this content updates in
 * place.
 */
export default function LiveRegion({ message }: LiveRegionProps) {
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
