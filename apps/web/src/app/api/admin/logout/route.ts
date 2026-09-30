import { NextRequest, NextResponse } from 'next/server';
import { getAdminCookieName } from '@/lib/admin-session';
import { verifyCsrfProtection } from '@/lib/csrf';

export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const response = NextResponse.json({ success: true });
  response.cookies.set(getAdminCookieName(), '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
