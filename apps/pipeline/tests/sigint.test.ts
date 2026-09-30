import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSigintFlag } from '../src/lib/sigint';

describe('installSigintFlag', () => {
  afterEach(() => {
    // Defensive: a test that forgets to uninstall shouldn't leak a listener into the next one.
    process.removeAllListeners('SIGINT');
  });

  it('starts uninterrupted', () => {
    const sigint = installSigintFlag();
    expect(sigint.interrupted()).toBe(false);
    sigint.uninstall();
  });

  it('flips to interrupted when SIGINT fires, and logs the given description', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sigint = installSigintFlag('finishing the in-flight call, then stopping...');

    process.emit('SIGINT');

    expect(sigint.interrupted()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finishing the in-flight call, then stopping...'));
    sigint.uninstall();
    logSpy.mockRestore();
  });

  it('is a one-shot handler: a second SIGINT after the first is not required to flip anything new', () => {
    const sigint = installSigintFlag();
    process.emit('SIGINT');
    expect(sigint.interrupted()).toBe(true);
    // process.once means the listener already removed itself; emitting again is a no-op for this
    // instance, not a crash.
    expect(() => process.emit('SIGINT')).not.toThrow();
    sigint.uninstall();
  });

  it('uninstall removes the listener so a later SIGINT does not flip an unrelated instance', () => {
    const first = installSigintFlag();
    first.uninstall();

    const second = installSigintFlag();
    process.emit('SIGINT');
    expect(second.interrupted()).toBe(true);
    expect(first.interrupted()).toBe(false);
    second.uninstall();
  });
});
