/**
 * Response bodies of the web app's student routes, shared by the web client and the native app.
 *
 * A native caller sends `platform: 'native'` to the two routes that mint a session and receives the
 * session as `token` in the body; the web client sends no `platform` and receives it as a cookie.
 * Error responses on these routes are `{ error: string }`, except the verify-code challenge below.
 */

/** A study code row as `verify-code` returns it. The nullable columns have no NOT NULL constraint. */
interface StudyCodeDetails {
  id: string;
  code: string;
  display_name: string | null;
  created_at: string | null;
  total_quizzes: number | null;
  total_questions: number | null;
  correct_answers: number | null;
}

/** `POST /api/verify-code`, 200. */
export type VerifyCodeResponse = { exists: false } | { exists: true; details: StudyCodeDetails };

/** `POST /api/verify-code` with `platform: 'native'`, 200. */
export type NativeVerifyCodeResponse =
  | { exists: false }
  | { exists: true; details: StudyCodeDetails; token: string };

/**
 * `POST /api/verify-code`, 403, while the circuit breaker requires a Turnstile challenge. A request
 * that carried no Turnstile token also gets a `Retry-After` header with the seconds until the
 * breaker resets. `turnstileSiteKey` is absent when the server has no site key configured.
 */
export interface VerifyCodeChallengeResponse {
  error: string;
  turnstileRequired: true;
  turnstileSiteKey?: string;
}

/** `POST /api/generate-code`, 200. */
export interface GenerateCodeResponse {
  code: string;
}

/** `POST /api/generate-code` with `platform: 'native'`, 200. */
export interface NativeGenerateCodeResponse extends GenerateCodeResponse {
  token: string;
}

/** `GET /api/student/session`, always 200. */
export interface StudentSessionResponse {
  authenticated: boolean;
}
