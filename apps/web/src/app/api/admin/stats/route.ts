import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-route-guard';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('admin/stats');

export async function GET(request: NextRequest) {
  const authError = requireAdmin(request);
  if (authError) return authError;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Database not available' }, { status: 503 });
  }

  try {
    const { count: totalStudyCodes } = await supabaseAdmin!
      .from('study_codes')
      .select('*', { count: 'exact', head: true });

    const { count: totalQuizzes } = await supabaseAdmin!
      .from('quiz_history')
      .select('*', { count: 'exact', head: true });

    const { data: studyCodes } = await supabaseAdmin!
      .from('study_codes')
      .select('total_questions, correct_answers');

    const totalQuestions = studyCodes?.reduce((sum: number, sc: { total_questions: number }) => sum + (sc.total_questions || 0), 0) || 0;
    const totalCorrect = studyCodes?.reduce((sum: number, sc: { correct_answers: number }) => sum + (sc.correct_answers || 0), 0) || 0;
    const averageAccuracy = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const { count: activeStudyCodesLast7Days } = await supabaseAdmin!
      .from('study_codes')
      .select('*', { count: 'exact', head: true })
      .gte('last_active_at', sevenDaysAgo.toISOString());

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { count: activeStudyCodesLast30Days } = await supabaseAdmin!
      .from('study_codes')
      .select('*', { count: 'exact', head: true })
      .gte('last_active_at', thirtyDaysAgo.toISOString());

    return NextResponse.json({
      totalStudyCodes: totalStudyCodes || 0,
      totalQuizzes: totalQuizzes || 0,
      totalQuestions,
      averageAccuracy,
      activeStudyCodesLast7Days: activeStudyCodesLast7Days || 0,
      activeStudyCodesLast30Days: activeStudyCodesLast30Days || 0,
    });
  } catch (error) {
    logger.error('Error fetching classwide stats', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
