import { NextRequest, NextResponse } from 'next/server';
import { verifySessionFromCookie, getAdminCookieName } from '@/lib/admin-session';

export async function GET(request: NextRequest) {
  const cookieValue = request.cookies.get(getAdminCookieName())?.value;
  const isValid = verifySessionFromCookie(cookieValue);

  return NextResponse.json({ authenticated: isValid });
}
