/** Trims and lowercases a typed study code, as the web app and the `verify-code` route both do. */
export function normalizeStudyCode(code: string): string {
  return code.trim().toLowerCase();
}
