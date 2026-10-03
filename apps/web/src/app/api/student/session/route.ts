import { NextRequest, NextResponse } from 'next/server';
import { readStudentSessionToken, verifyStudentSessionToken } from '@/lib/student-session';

export async function GET(request: NextRequest) {
  const token = readStudentSessionToken(request);
  const payload = verifyStudentSessionToken(token);

  return NextResponse.json({ authenticated: payload !== null });
}
