import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-route-guard';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('admin/stats');

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

export async function GET(request: NextRequest) {
  const authError = requireAdmin(request);
  if (authError) return authError;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    const headCount = () => ({ count: 'exact', head: true }) as const;

    const [totalStudyCodes, totalQuizzes, totalQuestions, totalCorrect, active7, active30] = await Promise.all([
      supabaseAdmin!.from('study_codes').select('*', headCount()),
      supabaseAdmin!.from('quiz_history').select('*', headCount()),
      supabaseAdmin!.from('question_results').select('*', headCount()),
      supabaseAdmin!.from('question_results').select('*', headCount()).eq('is_correct', true),
      supabaseAdmin!.from('study_codes').select('*', headCount()).gte('last_active_at', daysAgo(7)),
      supabaseAdmin!.from('study_codes').select('*', headCount()).gte('last_active_at', daysAgo(30)),
    ]);

    const failed = [totalStudyCodes, totalQuizzes, totalQuestions, totalCorrect, active7, active30].find(
      (result) => result.error,
    );
    if (failed) {
      logger.error('Error counting rows for classwide stats', supabaseErrorFields(failed.error));
      return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
    }

    const questionCount = totalQuestions.count ?? 0;
    const averageAccuracy = questionCount > 0 ? ((totalCorrect.count ?? 0) / questionCount) * 100 : 0;

    return NextResponse.json({
      totalStudyCodes: totalStudyCodes.count ?? 0,
      totalQuizzes: totalQuizzes.count ?? 0,
      totalQuestions: questionCount,
      averageAccuracy,
      activeStudyCodesLast7Days: active7.count ?? 0,
      activeStudyCodesLast30Days: active30.count ?? 0,
    });
  } catch (error) {
    logger.error('Error fetching classwide stats', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
