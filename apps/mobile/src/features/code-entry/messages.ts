import type { CodeEntryPhase } from './code-entry-store';

/** A wait in plain words, rounded up: "30 seconds", "4 minutes", "2 hours". */
export function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.ceil(seconds / 3600);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * `problem`: something the student typed or chose needs changing. `notice`: nothing is wrong with
 * the input, the service needs a moment. `neutral`: plain information.
 */
type MessageTone = 'problem' | 'notice' | 'neutral';

export interface CodeEntryMessage {
  text: string;
  tone: MessageTone;
  /** `code`: under the code field. `create`: under the button that creates a code. */
  place: 'code' | 'create';
}

/** The message the code-entry screen shows for a phase, or null when it shows none. */
export function codeEntryMessage(phase: CodeEntryPhase): CodeEntryMessage | null {
  switch (phase.status) {
    case 'invalid':
      return { text: 'Please enter a study code.', tone: 'problem', place: 'code' };
    case 'not-found':
      return {
        text: "Code not found. Check the spelling and try again, or tap I'm new for a new code.",
        tone: 'problem',
        place: 'code',
      };
    case 'wait': {
      const lead =
        phase.reason === 'site-busy'
          ? 'Lots of people are signing in right now.'
          : 'Too many tries from this network.';
      const when =
        phase.seconds === null ? 'in a few minutes' : `in about ${describeWait(phase.seconds)}`;
      return { text: `${lead} Please try again ${when}. Your code is still in the box.`, tone: 'notice', place: 'code' };
    }
    case 'wait-over':
      return { text: 'You can try again now.', tone: 'neutral', place: 'code' };
    case 'unavailable':
      return { text: 'Study codes are unavailable right now. Please try again later.', tone: 'notice', place: 'code' };
    case 'error':
      return { text: 'Something went wrong. Please try again.', tone: 'problem', place: 'code' };
    case 'create-failed':
      return { text: "We couldn't make a code just now. Please try again.", tone: 'problem', place: 'create' };
    default:
      return null;
  }
}

/** What a screen reader announces when the screen enters a phase, or null for nothing. */
export function codeEntryAnnouncement(phase: CodeEntryPhase): string | null {
  if (phase.status === 'creating') return 'Creating your study code';
  if (phase.status === 'created') return `Your study code is ${phase.code}. Write it down.`;
  return codeEntryMessage(phase)?.text ?? null;
}
