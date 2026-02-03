import { NextRequest, NextResponse } from 'next/server';
import { supabase, isSupabaseAvailable } from '@/lib/supabase';

/**
 * Check if a study code ID belongs to a superuser
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const studyCodeId = searchParams.get('studyCodeId');

  if (!studyCodeId || !isSupabaseAvailable()) {
    return NextResponse.json({ isSuperuser: false });
  }

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('is_superuser')
      .eq('id', studyCodeId)
      .single();

    if (error || !data) {
      return NextResponse.json({ isSuperuser: false });
    }

    return NextResponse.json({ isSuperuser: data.is_superuser === true });
  } catch (error) {
    console.error('Error checking superuser status:', error);
    return NextResponse.json({ isSuperuser: false });
  }
}
