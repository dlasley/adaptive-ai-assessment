import { describe, expect, it } from 'vitest';
import { codeEntryAnnouncement, codeEntryMessage, describeWait } from '../src/features/code-entry/messages';

describe('codeEntryMessage', () => {
  it('words each outcome and gives it a tone and a place', () => {
    expect(codeEntryMessage({ status: 'invalid' })).toEqual({
      text: 'Please enter a study code.',
      tone: 'problem',
      place: 'code',
    });
    expect(codeEntryMessage({ status: 'not-found' })).toEqual({
      text: "Code not found. Check the spelling and try again, or tap I'm new for a new code.",
      tone: 'problem',
      place: 'code',
    });
    expect(codeEntryMessage({ status: 'error' })).toEqual({
      text: 'Something went wrong. Please try again.',
      tone: 'problem',
      place: 'code',
    });
    expect(codeEntryMessage({ status: 'unavailable' })?.tone).toBe('notice');
    expect(codeEntryMessage({ status: 'wait', reason: 'site-busy', seconds: 30 })?.tone).toBe('notice');
    expect(codeEntryMessage({ status: 'wait-over' })).toEqual({
      text: 'You can try again now.',
      tone: 'neutral',
      place: 'code',
    });
  });

  it('shows nothing while idle, busy or done', () => {
    for (const status of ['idle', 'submitting', 'creating'] as const) expect(codeEntryMessage({ status })).toBeNull();
    expect(codeEntryMessage({ status: 'created', code: 'calm green otter' })).toBeNull();
  });
});

describe('codeEntryAnnouncement', () => {
  it('announces creating, the created code, and every message', () => {
    expect(codeEntryAnnouncement({ status: 'creating' })).toBe('Creating your study code');
    expect(codeEntryAnnouncement({ status: 'created', code: 'calm green otter' })).toBe(
      'Your study code is calm green otter. Write it down.',
    );
    expect(codeEntryAnnouncement({ status: 'create-failed' })).toBe(
      "We couldn't make a code just now. Please try again.",
    );
    expect(codeEntryAnnouncement({ status: 'submitting' })).toBeNull();
  });
});

describe('describeWait', () => {
  it('describes waits in plain words, rounded up', () => {
    expect(describeWait(1)).toBe('1 second');
    expect(describeWait(59)).toBe('59 seconds');
    expect(describeWait(61)).toBe('2 minutes');
    expect(describeWait(3600)).toBe('1 hour');
  });
});
