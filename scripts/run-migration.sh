#!/bin/bash

echo "Running database migration: add_admin_label"
echo "=========================================="
echo ""

# Check if SUPABASE_URL and SUPABASE_ANON_KEY are set
if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ] || [ -z "$NEXT_PUBLIC_SUPABASE_ANON_KEY" ]; then
  echo "Error: Supabase credentials not found in environment"
  echo "Please ensure .env.local is loaded or run:"
  echo "  source <(grep -v '^#' .env.local | xargs -I {} echo export {})"
  exit 1
fi

# Run the migration SQL
echo "Applying migration..."
psql "$NEXT_PUBLIC_SUPABASE_URL" < supabase/migrations/add_admin_label.sql

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Migration completed successfully!"
  echo ""
  echo "The admin_label column has been added to the study_codes table."
else
  echo ""
  echo "❌ Migration failed. Please run the SQL manually in your Supabase dashboard."
fi
