import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-route-guard';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { verifyCsrfProtection } from '@/lib/csrf';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('admin/study-codes/bulk-delete');

export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const authError = requireAdmin(request);
  if (authError) return authError;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Database not available' }, { status: 503 });
  }

  try {
    const { codes } = await request.json();

    if (!Array.isArray(codes) || codes.length === 0) {
      return NextResponse.json({ error: 'No codes provided' }, { status: 400 });
    }

    // Deduped up front so a repeated code in the request is counted once, both in the
    // deleted/failed totals and in the query itself.
    const uniqueCodes = [...new Set(codes as string[])];

    // A single statement deleting every matching row at once, rather than one
    // round trip per code: `.select()` after `.delete()` returns the rows
    // Postgres actually removed, so `deleted` reflects codes that existed
    // (an already-deleted or typo'd code reports as failed, not deleted).
    const { data: deletedRows, error } = await supabaseAdmin!
      .from('study_codes')
      .delete()
      .in('code', uniqueCodes)
      .select('code');

    if (error) {
      logger.error('Error bulk deleting study codes', supabaseErrorFields(error));
      return NextResponse.json({ error: 'Failed to delete study codes' }, { status: 500 });
    }

    const deletedCodes = new Set((deletedRows ?? []).map((row) => row.code as string));
    const failed = uniqueCodes.filter((code) => !deletedCodes.has(code));

    return NextResponse.json({
      success: failed.length === 0,
      deleted: deletedCodes.size,
      failed,
    });
  } catch (error) {
    logger.error('Error bulk deleting study codes', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Failed to delete study codes' }, { status: 500 });
  }
}
