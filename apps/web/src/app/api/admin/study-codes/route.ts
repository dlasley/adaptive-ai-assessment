import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-route-guard';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { dbToStudyCodeSummary } from '@/lib/study-code-mapper';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('admin/study-codes');

export async function GET(request: NextRequest) {
  const authError = requireAdmin(request);
  if (authError) return authError;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Database not available' }, { status: 503 });
  }

  const sortBy = request.nextUrl.searchParams.get('sortBy') || 'lastActive';
  const query = request.nextUrl.searchParams.get('q');

  try {
    const { data, error } = await supabaseAdmin!
      .from('study_codes')
      .select('*')
      .order('last_active_at', { ascending: false });

    if (error) {
      logger.error('Error fetching study codes', supabaseErrorFields(error));
      return NextResponse.json({ error: 'Failed to fetch study codes' }, { status: 500 });
    }

    // Filtered in application code rather than interpolated into a
    // PostgREST .or() filter string — this table is small, and a search
    // term with a comma or wildcard character can't reshape the query.
    const rows = query
      ? (data || []).filter((sc) => {
          const needle = query.toLowerCase();
          return (
            (sc.code as string | null)?.toLowerCase().includes(needle) ||
            (sc.display_name as string | null)?.toLowerCase().includes(needle) ||
            (sc.admin_label as string | null)?.toLowerCase().includes(needle)
          );
        })
      : data || [];

    const studyCodes = rows.map(dbToStudyCodeSummary);

    if (sortBy === 'accuracy') {
      studyCodes.sort((a, b) => (b.overallAccuracy as number) - (a.overallAccuracy as number));
    } else if (sortBy === 'quizzes') {
      studyCodes.sort((a, b) => (b.totalQuizzes as number) - (a.totalQuizzes as number));
    }

    return NextResponse.json(studyCodes);
  } catch (error) {
    logger.error('Error fetching study codes', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Failed to fetch study codes' }, { status: 500 });
  }
}
