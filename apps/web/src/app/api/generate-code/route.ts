import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { checkRateLimit, getClientIp } from '@/lib/rate-limiter';
import { verifyCsrfProtection } from '@/lib/csrf';
import { createStudentSessionCookie } from '@/lib/student-session';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('generate-code');

// Per-IP caps. The per-minute cap lets a class enrol together; the daily cap stops one source from
// reading the whole word pool out or filling the study_codes table.
const RATE_LIMIT_PER_MINUTE = { windowMs: 60_000, maxRequests: 30 };
const RATE_LIMIT_PER_DAY = { windowMs: 24 * 60 * 60 * 1000, maxRequests: 100 };
const MAX_ATTEMPTS = 10;
const MAX_FIRST_ADJECTIVE_DRAWS = 5;

type WordCategory = 'adjective' | 'animal';

/** Pick a random row from study_code_source_words by category using count + offset. */
async function pickRandom(category: WordCategory) {
  const { count } = await supabaseAdmin!
    .from('study_code_source_words')
    .select('id', { count: 'exact', head: true })
    .eq('category', category);

  if (!count) return null;

  const offset = Math.floor(Math.random() * count);
  const { data } = await supabaseAdmin!
    .from('study_code_source_words')
    .select('word, first_letter')
    .eq('category', category)
    .range(offset, offset)
    .single();

  return data;
}

/** Pick an animal that starts with `letter`, or any animal when none does. */
async function pickAnimalFor(letter: string): Promise<string | null> {
  const { data: matchingAnimals } = await supabaseAdmin!
    .from('study_code_source_words')
    .select('word')
    .eq('category', 'animal')
    .eq('first_letter', letter);

  if (matchingAnimals && matchingAnimals.length > 0) {
    return matchingAnimals[Math.floor(Math.random() * matchingAnimals.length)].word;
  }

  const fallback = await pickRandom('animal');
  return fallback?.word ?? null;
}

/** Pick an adjective different from `excluded`, or null if the pool keeps returning it. */
async function pickAdjectiveOtherThan(excluded: string): Promise<string | null> {
  for (let draw = 0; draw < MAX_FIRST_ADJECTIVE_DRAWS; draw++) {
    const adjective = await pickRandom('adjective');
    if (!adjective) return null;
    if (adjective.word !== excluded) return adjective.word;
  }
  return null;
}

/**
 * Generate a new study code server-side: two different adjectives and an animal, such as
 * "brave purple penguin". The second adjective and the animal share a first letter whenever the
 * pool has such an animal; the first adjective is drawn independently. Words come from
 * study_code_source_words (service role only). The code is inserted into study_codes with a
 * collision retry.
 */
export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const ip = getClientIp(request);
  for (const [scope, limit] of [
    ['minute', RATE_LIMIT_PER_MINUTE],
    ['day', RATE_LIMIT_PER_DAY],
  ] as const) {
    const rl = await checkRateLimit(`generate-code-${scope}:${ip}`, limit);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) } },
      );
    }
  }

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const secondAdjective = await pickRandom('adjective');
      if (!secondAdjective) {
        return NextResponse.json({ error: 'No adjectives available' }, { status: 500 });
      }

      const animal = await pickAnimalFor(secondAdjective.first_letter);
      if (!animal) {
        return NextResponse.json({ error: 'No animals available' }, { status: 500 });
      }

      const firstAdjective = await pickAdjectiveOtherThan(secondAdjective.word);
      if (!firstAdjective) {
        return NextResponse.json({ error: 'Not enough adjectives available' }, { status: 500 });
      }

      const code = `${firstAdjective} ${secondAdjective.word} ${animal}`;

      const { data: inserted, error: insertErr } = await supabaseAdmin!
        .from('study_codes')
        .insert({ code })
        .select('id, session_epoch')
        .single();

      if (!insertErr && inserted) {
        const response = NextResponse.json({ code });
        const cookie = createStudentSessionCookie(inserted.id, inserted.session_epoch);
        response.cookies.set(cookie.name, cookie.value, cookie.options as Parameters<typeof response.cookies.set>[2]);
        return response;
      }

      // Collision (unique constraint violation): retry with a new random draw
      if (insertErr.code === '23505') {
        continue;
      }

      logger.error('Failed to insert study code', supabaseErrorFields(insertErr));
      return NextResponse.json({ error: 'Failed to generate code' }, { status: 500 });
    }

    return NextResponse.json(
      { error: 'Failed to generate a unique code after multiple attempts. Please try again.' },
      { status: 500 },
    );
  } catch (error) {
    logger.error('generate-code error', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
