import { NextRequest, NextResponse } from 'next/server';
import { verifyCsrfProtection } from '@/lib/csrf';
import { clearedStudentSessionCookie } from '@/lib/student-session';

/**
 * Clears the student session cookie. Idempotent: a missing, expired, or
 * already-cleared cookie is not an error, so this never requires a valid
 * session to call.
 */
export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const response = NextResponse.json({ success: true });
  const cookie = clearedStudentSessionCookie();
  response.cookies.set(cookie.name, cookie.value, cookie.options as Parameters<typeof response.cookies.set>[2]);
  return response;
}
