import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeStudyCode } from '../src/features/code-entry/normalize-study-code';
import { canSubmit, shouldLeaveCodeEntry } from '../src/features/code-entry/code-entry-store';
import { codeEntryMessage } from '../src/features/code-entry/messages';
import { DETAILS, deferred, jsonResponse, setupCodeEntry } from './code-entry-harness';

const FOUND = { exists: true, details: DETAILS, token: 'signed.token' };
const CHALLENGE = { error: 'Verification required', turnstileRequired: true, turnstileSiteKey: 'site-key' };

/** A signed-out app on the code-entry screen with `typed` in the field. */
async function readyToSubmit(typed: string, options: Parameters<typeof setupCodeEntry>[0] = {}) {
  const app = setupCodeEntry(options);
  await app.session.restore();
  app.codeEntry.setInput(typed);
  return app;
}

/** A signed-out app on the code-entry screen with nothing typed. */
async function signedOut(options: Parameters<typeof setupCodeEntry>[0] = {}) {
  const app = setupCodeEntry(options);
  await app.session.restore();
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeStudyCode', () => {
  it('trims and lowercases, like the web app', () => {
    expect(normalizeStudyCode('  Brave PURPLE penguin \n')).toBe('brave purple penguin');
    expect(normalizeStudyCode('   ')).toBe('');
  });
});

describe('entering a code', () => {
  it('stores the token, records the code and reaches verified for a valid code', async () => {
    const app = await readyToSubmit('  Brave Purple Penguin ');
    app.on('/api/verify-code', () => jsonResponse(200, FOUND));

    await app.codeEntry.submit();

    expect(app.callsTo('/api/verify-code')[0].body).toEqual({ code: 'brave purple penguin', platform: 'native' });
    expect(await app.tokenStore.get()).toBe('signed.token');
    expect(await app.codeStore.get()).toBe('brave purple penguin');
    expect(app.codeEntry.getState().phase).toEqual({ status: 'verified', code: 'brave purple penguin' });
    expect(app.session.getState()).toEqual({ phase: 'signed-in', code: 'brave purple penguin' });
    expect(shouldLeaveCodeEntry(app.session.getState(), app.codeEntry.getState())).toBe(true);
  });

  it('shows not found, keeps the typed code and stores nothing', async () => {
    const app = await readyToSubmit('brave purple pengiun');
    app.on('/api/verify-code', () => jsonResponse(200, { exists: false }));

    await app.codeEntry.submit();

    expect(app.codeEntry.getState()).toMatchObject({ input: 'brave purple pengiun', phase: { status: 'not-found' } });
    expect(await app.tokenStore.get()).toBeNull();
    expect(app.session.getState().phase).toBe('signed-out');
  });

  it('rejects empty input before any request', async () => {
    const app = await readyToSubmit('   ');

    await app.codeEntry.submit();

    expect(app.codeEntry.getState().phase).toEqual({ status: 'invalid' });
    expect(app.fetch).not.toHaveBeenCalled();
  });

  it('shows the wait from Retry-After and keeps the code on a 403 challenge', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(403, CHALLENGE, { 'Retry-After': '240' }));

    await app.codeEntry.submit();

    expect(app.codeEntry.getState()).toMatchObject({
      input: 'brave purple penguin',
      phase: { status: 'wait', reason: 'site-busy', seconds: 240 },
    });
    expect(codeEntryMessage(app.codeEntry.getState().phase)).toEqual({
      text: 'Lots of people are signing in right now. Please try again in about 4 minutes. Your code is still in the box.',
      tone: 'notice',
      place: 'code',
    });
    expect(await app.tokenStore.get()).toBeNull();
  });

  it('shows the wait from Retry-After and keeps the code on a 429', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () =>
      jsonResponse(429, { error: 'Too many incorrect codes. Please try again later.' }, { 'Retry-After': '45' }),
    );

    await app.codeEntry.submit();

    expect(app.codeEntry.getState()).toMatchObject({
      input: 'brave purple penguin',
      phase: { status: 'wait', reason: 'rate-limited', seconds: 45 },
    });
    expect(codeEntryMessage(app.codeEntry.getState().phase)?.text).toBe(
      'Too many tries from this network. Please try again in about 45 seconds. Your code is still in the box.',
    );
  });

  it('keeps the wait on screen while the student edits the code', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(429, { error: 'x' }, { 'Retry-After': '45' }));
    await app.codeEntry.submit();

    app.codeEntry.setInput('brave purple penguins');

    expect(app.codeEntry.getState().phase.status).toBe('wait');
  });

  it('falls back to a general wait message, and allows a retry, when Retry-After is missing', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(429, { error: 'x' }));

    await app.codeEntry.submit();

    expect(app.codeEntry.getState().phase).toEqual({ status: 'wait', reason: 'rate-limited', seconds: null });
    expect(codeEntryMessage(app.codeEntry.getState().phase)?.text).toBe(
      'Too many tries from this network. Please try again in a few minutes. Your code is still in the box.',
    );
    expect(canSubmit(app.codeEntry.getState())).toBe(true);
  });

  it('treats a 403 that is not a challenge as an error, not a wait', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(403, { error: 'Origin not allowed' }));

    await app.codeEntry.submit();

    expect(app.codeEntry.getState().phase).toEqual({ status: 'error' });
  });

  it('maps a 400 from verify-code to the general error', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(400, { error: 'Invalid request body' }));

    await app.codeEntry.submit();

    expect(app.codeEntry.getState()).toMatchObject({ input: 'brave purple penguin', phase: { status: 'error' } });
  });

  it('shows unavailable on a 503, in the notice tone, and keeps the code', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(503, { error: 'Service unavailable' }));

    await app.codeEntry.submit();

    expect(app.codeEntry.getState()).toMatchObject({ input: 'brave purple penguin', phase: { status: 'unavailable' } });
    expect(codeEntryMessage(app.codeEntry.getState().phase)?.tone).toBe('notice');
  });

  it('shows an error on a network failure and keeps the code', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => {
      throw new TypeError('Network request failed');
    });

    await app.codeEntry.submit();

    expect(app.codeEntry.getState()).toMatchObject({ input: 'brave purple penguin', phase: { status: 'error' } });
    expect(await app.tokenStore.get()).toBeNull();
  });

  it('dismisses a not-found message as soon as the student types', async () => {
    const app = await readyToSubmit('brave purple pengiun');
    app.on('/api/verify-code', () => jsonResponse(200, { exists: false }));
    await app.codeEntry.submit();

    app.codeEntry.setInput('brave purple penguin');

    expect(app.codeEntry.getState()).toMatchObject({ input: 'brave purple penguin', phase: { status: 'idle' } });
  });

  it('is submitting while the request is in flight and ignores a second submit', async () => {
    const app = await readyToSubmit('brave purple penguin');
    const held = deferred<Response>();
    app.on('/api/verify-code', () => held.promise);

    const first = app.codeEntry.submit();
    expect(app.codeEntry.getState().phase).toEqual({ status: 'submitting' });
    expect(canSubmit(app.codeEntry.getState())).toBe(false);
    await app.codeEntry.submit();
    held.resolve(jsonResponse(200, { exists: false }));
    await first;

    expect(app.callsTo('/api/verify-code')).toHaveLength(1);
    expect(app.codeEntry.getState().phase).toEqual({ status: 'not-found' });
  });

  it('clears the previously stored code before asking the server to mint a token', async () => {
    const app = await readyToSubmit('calm green otter', { code: 'brave purple penguin' });
    let storedCodeDuringRequest: string | null = 'unread';
    app.on('/api/verify-code', async () => {
      storedCodeDuringRequest = await app.codeStore.get();
      return jsonResponse(200, { ...FOUND, details: { ...DETAILS, code: 'calm green otter' } });
    });

    await app.codeEntry.submit();

    expect(storedCodeDuringRequest).toBeNull();
    expect(await app.codeStore.get()).toBe('calm green otter');
  });

  it('shows an error and removes the new token when the code cannot be stored', async () => {
    const app = await readyToSubmit('brave purple penguin', {
      codeStore: {
        set: async () => {
          throw new Error('keychain unavailable');
        },
      },
    });
    app.on('/api/verify-code', () => jsonResponse(200, FOUND));

    await app.codeEntry.submit();

    expect(app.codeEntry.getState().phase).toEqual({ status: 'error' });
    expect(await app.tokenStore.get()).toBeNull();
    expect(app.session.getState().phase).toBe('signed-out');
  });
});

describe('waiting out a limit', () => {
  it('disables Continue, counts the seconds down, then lets the student try again', async () => {
    vi.useFakeTimers();
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(429, { error: 'x' }, { 'Retry-After': '3' }));
    await app.codeEntry.submit();
    const announcementAtStart = app.codeEntry.getState().announcement;

    expect(canSubmit(app.codeEntry.getState())).toBe(false);
    await app.codeEntry.submit();
    expect(app.callsTo('/api/verify-code')).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(app.codeEntry.getState().phase).toMatchObject({ status: 'wait', seconds: 2 });
    expect(app.codeEntry.getState().announcement).toBe(announcementAtStart);

    vi.advanceTimersByTime(2000);
    expect(app.codeEntry.getState().phase).toEqual({ status: 'wait-over' });
    expect(codeEntryMessage(app.codeEntry.getState().phase)?.text).toBe('You can try again now.');
    expect(app.codeEntry.getState().announcement?.text).toBe('You can try again now.');
    expect(app.codeEntry.getState().input).toBe('brave purple penguin');
    expect(canSubmit(app.codeEntry.getState())).toBe(true);
  });

  it('stops counting when the student leaves the wait by creating a code', async () => {
    vi.useFakeTimers();
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(403, CHALLENGE, { 'Retry-After': '5' }));
    app.on('/api/generate-code', () => jsonResponse(200, { code: 'calm green otter', token: 'new.token' }));
    await app.codeEntry.submit();

    await app.codeEntry.create();
    vi.advanceTimersByTime(10_000);

    expect(app.codeEntry.getState().phase).toEqual({ status: 'created', code: 'calm green otter' });
  });
});

describe('creating a code', () => {
  it('is busy, then shows the new code, then continues once acknowledged', async () => {
    const app = await signedOut();
    const phases: string[] = [];
    app.codeEntry.subscribe(() => phases.push(app.codeEntry.getState().phase.status));
    app.on('/api/generate-code', () => jsonResponse(200, { code: 'calm green otter', token: 'new.token' }));

    await app.codeEntry.create();

    expect(phases).toEqual(['creating', 'created']);
    expect(app.callsTo('/api/generate-code')[0].body).toEqual({ platform: 'native' });
    expect(app.codeEntry.getState().phase).toEqual({ status: 'created', code: 'calm green otter' });
    expect(app.codeEntry.getState().announcement?.text).toBe('Your study code is calm green otter. Write it down.');
    expect(await app.tokenStore.get()).toBe('new.token');
    expect(await app.codeStore.get()).toBe('calm green otter');
    expect(shouldLeaveCodeEntry(app.session.getState(), app.codeEntry.getState())).toBe(false);

    app.codeEntry.continueAfterCreate();

    expect(app.codeEntry.getState().phase).toEqual({ status: 'verified', code: 'calm green otter' });
    expect(shouldLeaveCodeEntry(app.session.getState(), app.codeEntry.getState())).toBe(true);
  });

  it('announces that a code is being created', async () => {
    const app = await signedOut();
    const held = deferred<Response>();
    app.on('/api/generate-code', () => held.promise);

    const creating = app.codeEntry.create();
    expect(app.codeEntry.getState().announcement?.text).toBe('Creating your study code');
    held.resolve(jsonResponse(200, { code: 'calm green otter', token: 'new.token' }));
    await creating;
  });

  it('does not leave code entry while the code is still being created', async () => {
    const app = await signedOut();
    const leaveWhileCreating: boolean[] = [];
    app.session.subscribe(() =>
      leaveWhileCreating.push(shouldLeaveCodeEntry(app.session.getState(), app.codeEntry.getState())),
    );
    app.on('/api/generate-code', () => jsonResponse(200, { code: 'calm green otter', token: 'new.token' }));

    await app.codeEntry.create();

    expect(leaveWhileCreating).toEqual([false]);
  });

  it('makes one code when create is pressed twice', async () => {
    const app = await signedOut();
    const held = deferred<Response>();
    app.on('/api/generate-code', () => held.promise);

    const first = app.codeEntry.create();
    await app.codeEntry.create();
    held.resolve(jsonResponse(200, { code: 'calm green otter', token: 'new.token' }));
    await first;

    expect(app.callsTo('/api/generate-code')).toHaveLength(1);
    expect(app.codeEntry.getState().phase).toEqual({ status: 'created', code: 'calm green otter' });
  });

  it('ignores create while a submitted code is being checked', async () => {
    const app = await readyToSubmit('brave purple penguin');
    const held = deferred<Response>();
    app.on('/api/verify-code', () => held.promise);

    const submitting = app.codeEntry.submit();
    await app.codeEntry.create();
    held.resolve(jsonResponse(200, FOUND));
    await submitting;

    expect(app.callsTo('/api/generate-code')).toHaveLength(0);
    expect(app.codeEntry.getState().phase).toEqual({ status: 'verified', code: 'brave purple penguin' });
  });

  it.each([
    ['a 429', () => jsonResponse(429, { error: 'x' }, { 'Retry-After': '30' })],
    ['a 503', () => jsonResponse(503, { error: 'Service unavailable' })],
    ['a 500', () => jsonResponse(500, { error: 'Internal server error' })],
    [
      'a network failure',
      () => {
        throw new TypeError('Network request failed');
      },
    ],
  ])('shows the create failure under the create button on %s', async (_name, respond) => {
    const app = await signedOut();
    app.on('/api/generate-code', respond);

    await app.codeEntry.create();

    expect(app.codeEntry.getState().phase).toEqual({ status: 'create-failed' });
    expect(codeEntryMessage(app.codeEntry.getState().phase)).toEqual({
      text: "We couldn't make a code just now. Please try again.",
      tone: 'problem',
      place: 'create',
    });
    expect(await app.tokenStore.get()).toBeNull();
    expect(app.session.getState().phase).toBe('signed-out');
  });

  it('shows the create failure and removes the new token when the code cannot be stored', async () => {
    const app = await signedOut({
      codeStore: {
        set: async () => {
          throw new Error('keychain unavailable');
        },
      },
    });
    app.on('/api/generate-code', () => jsonResponse(200, { code: 'calm green otter', token: 'new.token' }));

    await app.codeEntry.create();

    expect(app.codeEntry.getState().phase).toEqual({ status: 'create-failed' });
    expect(await app.tokenStore.get()).toBeNull();
  });

  it('never leaves one student\'s code beside another student\'s token', async () => {
    const app = await signedOut({ code: 'brave purple penguin' });
    let storedCodeWhenTokenArrived: string | null = 'unread';
    app.tokenStore.subscribe((hasToken) => {
      if (hasToken) void app.codeStore.get().then((code) => (storedCodeWhenTokenArrived = code));
    });
    app.on('/api/generate-code', () => jsonResponse(200, { code: 'calm green otter', token: 'new.token' }));

    await app.codeEntry.create();

    expect(storedCodeWhenTokenArrived).toBeNull();
  });
});

describe('"this isn\'t me"', () => {
  it('clears the token and the remembered code and returns to an empty idle screen', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(200, FOUND));
    await app.codeEntry.submit();

    await app.session.signOut();

    expect(await app.tokenStore.get()).toBeNull();
    expect(await app.codeStore.get()).toBeNull();
    expect(app.session.getState()).toEqual({ phase: 'signed-out', code: null });
    expect(app.codeEntry.getState()).toMatchObject({ input: '', phase: { status: 'idle' } });
    expect(shouldLeaveCodeEntry(app.session.getState(), app.codeEntry.getState())).toBe(false);
  });

  it('signs out even when clearing storage fails, retrying the clear once', async () => {
    let tokenClears = 0;
    const app = setupCodeEntry({
      token: 'stored.token',
      code: 'brave purple penguin',
      tokenStore: {
        clear: async () => {
          tokenClears++;
          throw new Error('keychain unavailable');
        },
      },
    });
    app.on('/api/student/session', () => jsonResponse(200, { authenticated: true }));
    await app.session.restore();

    await expect(app.session.signOut()).resolves.toBeUndefined();

    expect(tokenClears).toBe(2);
    expect(app.session.getState()).toEqual({ phase: 'signed-out', code: null });
    expect(await app.codeStore.get()).toBeNull();
  });

  it('clears the token on the retry when the first clear fails', async () => {
    let tokenClears = 0;
    let stored: string | null = 'stored.token';
    const app = setupCodeEntry({
      code: 'brave purple penguin',
      tokenStore: {
        get: async () => stored,
        clear: async () => {
          tokenClears++;
          if (tokenClears === 1) throw new Error('keychain busy');
          stored = null;
        },
      },
    });
    app.on('/api/student/session', () => jsonResponse(200, { authenticated: true }));
    await app.session.restore();

    await app.session.signOut();

    expect(tokenClears).toBe(2);
    expect(stored).toBeNull();
    expect(app.session.getState()).toEqual({ phase: 'signed-out', code: null });
  });
});

describe('session restore on launch', () => {
  it('goes straight on when the stored token is still accepted', async () => {
    const app = setupCodeEntry({ token: 'stored.token', code: 'brave purple penguin' });
    app.on('/api/student/session', () => jsonResponse(200, { authenticated: true }));

    expect(app.session.getState().phase).toBe('restoring');
    await app.session.restore();

    expect(app.callsTo('/api/student/session')[0].init.headers).toMatchObject({ Authorization: 'Bearer stored.token' });
    expect(app.session.getState()).toEqual({ phase: 'signed-in', code: 'brave purple penguin' });
    expect(await app.tokenStore.get()).toBe('stored.token');
    expect(shouldLeaveCodeEntry(app.session.getState(), app.codeEntry.getState())).toBe(true);
  });

  it('clears a token the server no longer accepts and shows code entry with the code offered', async () => {
    const app = setupCodeEntry({ token: 'stale.token', code: 'brave purple penguin' });
    app.on('/api/student/session', () => jsonResponse(200, { authenticated: false }));

    await app.session.restore();

    expect(await app.tokenStore.get()).toBeNull();
    expect(app.session.getState()).toEqual({ phase: 'signed-out', code: 'brave purple penguin' });
    expect(app.codeEntry.getState()).toMatchObject({ input: 'brave purple penguin', phase: { status: 'idle' } });
    expect(shouldLeaveCodeEntry(app.session.getState(), app.codeEntry.getState())).toBe(false);
  });

  it('shows code entry without asking the server when no token is stored', async () => {
    const app = setupCodeEntry();

    await app.session.restore();

    expect(app.fetch).not.toHaveBeenCalled();
    expect(app.session.getState()).toEqual({ phase: 'signed-out', code: null });
  });

  it('keeps the token and goes on when the server cannot be reached', async () => {
    const app = setupCodeEntry({ token: 'stored.token', code: 'brave purple penguin' });
    app.on('/api/student/session', () => {
      throw new TypeError('Network request failed');
    });

    await app.session.restore();

    expect(await app.tokenStore.get()).toBe('stored.token');
    expect(app.session.getState().phase).toBe('signed-in');
  });

  it('keeps the token and goes on when the session route answers 5xx', async () => {
    const app = setupCodeEntry({ token: 'stored.token', code: 'brave purple penguin' });
    app.on('/api/student/session', () => jsonResponse(503, { error: 'Service unavailable' }));

    await app.session.restore();

    expect(await app.tokenStore.get()).toBe('stored.token');
    expect(app.session.getState()).toEqual({ phase: 'signed-in', code: 'brave purple penguin' });
  });

  it('lands signed out with no code when the stored token cannot be read', async () => {
    const app = setupCodeEntry({
      code: 'brave purple penguin',
      tokenStore: {
        get: async () => {
          throw new Error('keychain unavailable');
        },
      },
    });

    await expect(app.session.restore()).resolves.toBeUndefined();

    expect(app.session.getState()).toEqual({ phase: 'signed-out', code: null });
    expect(app.codeEntry.getState()).toMatchObject({ input: '', phase: { status: 'idle' } });
  });

  it('lands signed out with no code when a rejected token cannot be cleared', async () => {
    const app = setupCodeEntry({
      token: 'stale.token',
      code: 'brave purple penguin',
      tokenStore: {
        clearIf: async () => {
          throw new Error('keychain unavailable');
        },
      },
    });
    app.on('/api/student/session', () => jsonResponse(200, { authenticated: false }));

    await expect(app.session.restore()).resolves.toBeUndefined();

    expect(app.session.getState()).toEqual({ phase: 'signed-out', code: null });
  });

  it('runs once however many times it is called', async () => {
    const app = setupCodeEntry({ token: 'stored.token' });
    app.on('/api/student/session', () => jsonResponse(200, { authenticated: true }));

    await Promise.all([app.session.restore(), app.session.restore()]);
    await app.session.restore();

    expect(app.callsTo('/api/student/session')).toHaveLength(1);
  });
});

describe('token disappearing mid-session', () => {
  it('signs out and returns code entry to idle with the code offered when any call gets a 401', async () => {
    const app = await readyToSubmit('brave purple penguin');
    app.on('/api/verify-code', () => jsonResponse(200, FOUND));
    await app.codeEntry.submit();
    expect(app.session.getState().phase).toBe('signed-in');

    app.on('/api/course', () => jsonResponse(401, { error: 'Unauthorized' }));
    await app.client.getCourse().catch(() => undefined);

    expect(await app.tokenStore.get()).toBeNull();
    expect(app.session.getState()).toEqual({ phase: 'signed-out', code: 'brave purple penguin' });
    expect(app.codeEntry.getState()).toMatchObject({ input: 'brave purple penguin', phase: { status: 'idle' } });
    expect(shouldLeaveCodeEntry(app.session.getState(), app.codeEntry.getState())).toBe(false);
  });

  it('stays signed in on errors other than 401', async () => {
    const app = setupCodeEntry({ token: 'stored.token', code: 'brave purple penguin' });
    app.on('/api/student/session', () => jsonResponse(200, { authenticated: true }));
    await app.session.restore();

    app.on('/api/course', () => jsonResponse(500, { error: 'x' }));
    await app.client.getCourse().catch(() => undefined);

    expect(app.session.getState().phase).toBe('signed-in');
  });
});
