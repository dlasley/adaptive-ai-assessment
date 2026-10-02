import { NextResponse } from 'next/server';

/** A 429 whose Retry-After is the whole seconds left in the rate-limit window, never below 1. */
export function tooManyRequestsResponse(message: string, resetAt: number): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) } },
  );
}
