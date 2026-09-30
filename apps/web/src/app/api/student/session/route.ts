import { NextRequest, NextResponse } from 'next/server';
import { getStudentCookieName, verifyStudentSessionToken } from '@/lib/student-session';

export async function GET(request: NextRequest) {
  const cookieValue = request.cookies.get(getStudentCookieName())?.value;
  const payload = verifyStudentSessionToken(cookieValue);

  return NextResponse.json({ authenticated: payload !== null });
}
