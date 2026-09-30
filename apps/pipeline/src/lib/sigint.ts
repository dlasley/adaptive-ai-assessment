/**
 * A one-shot SIGINT handler that flips a flag instead of terminating the process immediately, so a
 * long-running loop can finish whatever unit of work is already in flight — a group, a call —
 * before stopping cleanly rather than aborting mid-call.
 */
export function installSigintFlag(
  inFlightDescription = 'finishing the in-flight work, then stopping...',
): { interrupted: () => boolean; uninstall: () => void } {
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    console.log(`\nReceived SIGINT — ${inFlightDescription}`);
  };
  process.once('SIGINT', onSigint);
  return {
    interrupted: () => interrupted,
    uninstall: () => process.removeListener('SIGINT', onSigint),
  };
}
