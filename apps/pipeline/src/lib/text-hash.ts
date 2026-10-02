import crypto from 'crypto';

/** First 16 hex characters of the SHA-256 of `text`. Stored as the prompt hash on runs and
 * audit rows, so the output for a given input must stay stable. */
export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}
