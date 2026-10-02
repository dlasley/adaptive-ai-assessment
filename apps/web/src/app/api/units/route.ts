import { NextResponse } from 'next/server';
import { supabase, isSupabaseAvailable } from '@/lib/supabase';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('units');

export async function GET() {
  if (!isSupabaseAvailable()) {
    return NextResponse.json(
      { error: 'Service unavailable' },
      { status: 503 },
    );
  }

  const { data, error } = await supabase!
    .from('units')
    .select('id, title, label, description, topics, sort_order')
    .order('sort_order');

  if (error) {
    logger.error('Failed to fetch units', supabaseErrorFields(error));
    return NextResponse.json(
      { error: 'Failed to fetch units' },
      { status: 500 },
    );
  }

  return NextResponse.json(data, {
    headers: {
      // Short CDN cache: units are edited by hand (via the DB, not a
      // deploy), and there's no invalidation hook to bust a longer cache on
      // save. 5 minutes bounds how stale a unit edit can appear; the
      // 60-second stale-while-revalidate keeps most requests off the origin.
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=60',
    },
  });
}
