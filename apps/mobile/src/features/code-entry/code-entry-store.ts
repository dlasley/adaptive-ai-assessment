/**
 * State of the code-entry screen: the text the student typed, and where the last action left it.
 *
 * Entering a code posts it to `verify-code`; creating one posts to `generate-code`. The API client
 * stores the session token either route returns, and this store then records the code with the
 * session store. While the site-wide breaker demands a challenge (403 `turnstileRequired`) or a
 * rate limit applies (429), the screen counts down the wait taken from `Retry-After`, keeps the
 * typed code, and refuses to submit until the wait is over. Whenever the session ends, the screen
 * returns to `idle` holding the code the session store offers back.
 *
 * `announcement` changes only when the phase changes, never on a countdown tick, so a screen
 * reader hears each outcome once.
 */

import type { VerifyCodeChallengeResponse } from '@adaptive/shared/api-contracts';
import type { ApiClient, ApiResult } from '../../api/client';
import { codeEntryAnnouncement } from './messages';
import { normalizeStudyCode } from './normalize-study-code';
import type { SessionState, SessionStore } from './session-store';

/** `site-busy`: the breaker tripped on failed lookups across the whole site. */
type WaitReason = 'site-busy' | 'rate-limited';

export type CodeEntryPhase =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'invalid' }
  | { status: 'not-found' }
  /** `seconds` counts down to zero; null when the server gave no usable `Retry-After`. */
  | { status: 'wait'; reason: WaitReason; seconds: number | null }
  | { status: 'wait-over' }
  | { status: 'unavailable' }
  | { status: 'error' }
  | { status: 'creating' }
  | { status: 'create-failed' }
  | { status: 'created'; code: string }
  | { status: 'verified'; code: string };

export interface CodeEntryState {
  input: string;
  phase: CodeEntryPhase;
  announcement: { id: number; text: string } | null;
}

export interface CodeEntryStore {
  getState(): CodeEntryState;
  subscribe(listener: () => void): () => void;
  setInput(text: string): void;
  submit(): Promise<void>;
  create(): Promise<void>;
  /** Leaves the newly created code's screen once the student has written the code down. */
  continueAfterCreate(): void;
}

export interface CodeEntryStoreDeps {
  client: Pick<ApiClient, 'verifyCode' | 'generateCode'>;
  session: SessionStore;
}

/** Phases a new keystroke dismisses. A wait stays on screen, since it still applies. */
const DISMISSED_BY_TYPING = new Set<CodeEntryPhase['status']>([
  'invalid',
  'not-found',
  'unavailable',
  'error',
  'create-failed',
  'wait-over',
]);

function isChallenge(body: unknown): body is VerifyCodeChallengeResponse {
  return typeof body === 'object' && body !== null && (body as { turnstileRequired?: unknown }).turnstileRequired === true;
}

/** The phase a failed `verify-code` call leads to. */
function verifyFailurePhase(result: Extract<ApiResult<unknown>, { ok: false }>): CodeEntryPhase {
  if (result.status === 403 && isChallenge(result.body)) {
    return { status: 'wait', reason: 'site-busy', seconds: result.retryAfterSeconds };
  }
  if (result.status === 429) return { status: 'wait', reason: 'rate-limited', seconds: result.retryAfterSeconds };
  if (result.status === 503) return { status: 'unavailable' };
  return { status: 'error' };
}

/** Whether Continue may send the typed code now. */
export function canSubmit(state: CodeEntryState): boolean {
  const { phase } = state;
  if (phase.status === 'submitting' || phase.status === 'creating') return false;
  return !(phase.status === 'wait' && phase.seconds !== null);
}

export function createCodeEntryStore({ client, session }: CodeEntryStoreDeps): CodeEntryStore {
  let state: CodeEntryState = {
    input: session.getState().code ?? '',
    phase: { status: 'idle' },
    announcement: null,
  };
  let announcementId = 0;
  let countdown: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function emit(next: CodeEntryState) {
    state = next;
    for (const listener of listeners) listener();
  }

  function stopCountdown() {
    if (countdown !== null) clearTimeout(countdown);
    countdown = null;
  }

  function startCountdown(seconds: number) {
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (state.phase.status !== 'wait') return;
      if (remaining <= 0) {
        setPhase({ status: 'wait-over' });
        return;
      }
      emit({ ...state, phase: { ...state.phase, seconds: remaining } });
      countdown = setTimeout(tick, 1000);
    };
    countdown = setTimeout(tick, 1000);
  }

  /** Moves to a new phase and announces it. Countdown ticks bypass this, so they stay silent. */
  function setPhase(phase: CodeEntryPhase, input = state.input) {
    stopCountdown();
    const text = codeEntryAnnouncement(phase);
    const announcement = text === null ? state.announcement : { id: ++announcementId, text };
    emit({ input, phase, announcement });
    if (phase.status === 'wait' && phase.seconds !== null) startCountdown(phase.seconds);
  }

  function isBusy() {
    return state.phase.status === 'submitting' || state.phase.status === 'creating';
  }

  let sessionPhase = session.getState().phase;
  session.subscribe(() => {
    const next = session.getState();
    if (next.phase === 'signed-out' && sessionPhase !== 'signed-out') {
      setPhase({ status: 'idle' }, next.code ?? '');
    }
    sessionPhase = next.phase;
  });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setInput: (text) => {
      if (DISMISSED_BY_TYPING.has(state.phase.status)) setPhase({ status: 'idle' }, text);
      else emit({ ...state, input: text });
    },

    submit: async () => {
      if (!canSubmit(state)) return;
      const code = normalizeStudyCode(state.input);
      if (!code) {
        setPhase({ status: 'invalid' });
        return;
      }

      setPhase({ status: 'submitting' });
      if (!(await session.prepareSignIn())) {
        setPhase({ status: 'error' });
        return;
      }
      let result: Awaited<ReturnType<typeof client.verifyCode>>;
      try {
        result = await client.verifyCode(code);
      } catch {
        setPhase({ status: 'error' });
        return;
      }

      if (!result.ok) {
        setPhase(verifyFailurePhase(result));
      } else if (!result.body.exists) {
        setPhase({ status: 'not-found' });
      } else if (await session.signIn(code, result.body.token)) {
        setPhase({ status: 'verified', code });
      } else {
        setPhase({ status: 'error' });
      }
    },

    create: async () => {
      if (isBusy()) return;
      setPhase({ status: 'creating' });
      if (!(await session.prepareSignIn())) {
        setPhase({ status: 'create-failed' });
        return;
      }
      let result: Awaited<ReturnType<typeof client.generateCode>>;
      try {
        result = await client.generateCode();
      } catch {
        setPhase({ status: 'create-failed' });
        return;
      }

      if (result.ok && (await session.signIn(result.body.code, result.body.token))) {
        setPhase({ status: 'created', code: result.body.code });
      } else {
        setPhase({ status: 'create-failed' });
      }
    },

    continueAfterCreate: () => {
      if (state.phase.status === 'created') setPhase({ status: 'verified', code: state.phase.code });
    },
  };
}

/**
 * Whether the code-entry screen should hand over to the signed-in screens: after a code was
 * verified or a new one acknowledged, or when a session restored on launch finds the screen idle.
 * A session that starts while a code is being created waits until the student has seen the code.
 */
export function shouldLeaveCodeEntry(session: SessionState, entry: CodeEntryState): boolean {
  return entry.phase.status === 'verified' || (session.phase === 'signed-in' && entry.phase.status === 'idle');
}
