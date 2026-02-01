/**
 * Database setup script
 * Creates the writing_questions table in Supabase
 *
 * Usage:
 *   npx tsx scripts/setup-database.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// Load environment variables from .env.local
config({ path: resolve(__dirname, '../.env.local') });

// Initialize Supabase with service role key if available, otherwise anon key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function setupDatabase() {
  console.log('🚀 Setting up database...');
  console.log('─'.repeat(50));

  try {
    // Read the SQL migration file
    const sqlPath = resolve(__dirname, '../supabase/migrations/create_writing_questions_table.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('\n📝 Executing SQL migration...');
    console.log(`   File: ${sqlPath}`);

    // Note: Supabase client doesn't support executing raw SQL directly
    // This needs to be run through the Supabase dashboard or CLI
    console.log('\n⚠️  To create the table, please run this SQL in your Supabase SQL Editor:');
    console.log('─'.repeat(50));
    console.log(sql);
    console.log('─'.repeat(50));
    console.log('\n💡 Steps:');
    console.log('   1. Go to https://apqdfwlfavbfgvhtgkyf.supabase.co/project/apqdfwlfavbfgvhtgkyf/sql');
    console.log('   2. Copy and paste the SQL above');
    console.log('   3. Click "Run" to execute');
    console.log('   4. Run the generate-initial-questions.ts script again');
    console.log('');

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

// Run the setup
setupDatabase();
