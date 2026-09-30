import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('evaluate-writing');

/**
 * Check if a study code ID belongs to a superuser
 */
export async function isSuperuser(studyCodeId: string): Promise<boolean> {
  if (!isSupabaseAdminAvailable()) {
    return false;
  }

  try {
    const { data, error } = await supabaseAdmin!
      .from('study_codes')
      .select('is_superuser')
      .eq('id', studyCodeId)
      .single();

    if (error || !data) {
      return false;
    }

    return data.is_superuser === true;
  } catch (error) {
    logger.error('Error checking superuser status', supabaseErrorFields(error));
    return false;
  }
}
