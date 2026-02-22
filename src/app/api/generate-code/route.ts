import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { supabase, isSupabaseAvailable } from '@/lib/supabase';
import { checkRateLimit, getClientIp } from '@/lib/rate-limiter';

const RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };
const MAX_ATTEMPTS = 10;

/** Pick a random row from study_code_source_words by category using count + offset. */
async function pickRandom(category: 'adjective' | 'animal') {
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

/**
 * Generate a new study code server-side.
 * Reads word lists from study_code_source_words (service role only),
 * prefers alliterative pairs, inserts into study_codes with collision retry.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`generate-code:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  if (!isSupabaseAdminAvailable() || !isSupabaseAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 1. Pick a random adjective
      const adjective = await pickRandom('adjective');
      if (!adjective) {
        return NextResponse.json({ error: 'No adjectives available' }, { status: 500 });
      }

      // 2. Try alliterative match first
      let animal: string | null = null;

      const { data: matchingAnimals } = await supabaseAdmin!
        .from('study_code_source_words')
        .select('word')
        .eq('category', 'animal')
        .eq('first_letter', adjective.first_letter);

      if (matchingAnimals && matchingAnimals.length > 0) {
        animal = matchingAnimals[Math.floor(Math.random() * matchingAnimals.length)].word;
      }

      // 3. Fallback: any random animal
      if (!animal) {
        const fallback = await pickRandom('animal');
        animal = fallback?.word ?? null;
      }

      if (!animal) {
        return NextResponse.json({ error: 'No animals available' }, { status: 500 });
      }

      const code = `${adjective.word} ${animal}`;

      // 4. Insert into study_codes (anon client has INSERT policy)
      const { error: insertErr } = await supabase!
        .from('study_codes')
        .insert({ code })
        .select()
        .single();

      if (!insertErr) {
        return NextResponse.json({ code });
      }

      // Collision (unique constraint violation) — retry with new random pair
      if (insertErr.code === '23505') {
        continue;
      }

      console.error('Failed to insert study code:', insertErr);
      return NextResponse.json({ error: 'Failed to generate code' }, { status: 500 });
    }

    return NextResponse.json(
      { error: 'Failed to generate a unique code after multiple attempts. Please try again.' },
      { status: 500 },
    );
  } catch (error) {
    console.error('generate-code error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
