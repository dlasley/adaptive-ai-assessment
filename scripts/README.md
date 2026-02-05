# Scripts Directory

## Generate Initial Writing Questions

This script generates 50 diverse French writing questions and saves them to your database.

### Prerequisites

1. **Supabase Setup:**
   - Ensure you have run the `create_writing_questions.sql` migration
   - Set environment variables in `.env.local`:
     ```
     NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
     NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
     ```

2. **Anthropic API Key:**
   - Set in `.env.local`:
     ```
     ANTHROPIC_API_KEY=your_anthropic_api_key
     ```

### Running the Script

```bash
# From the project root directory
npx tsx scripts/generate-initial-questions.ts
```

### What It Does

1. **Generates 50 Questions** using Claude Sonnet 4.5:
   - 20 beginner questions (40%)
   - 15 intermediate questions (30%)
   - 15 advanced questions (30%)

2. **Question Distribution:**
   - Basic greetings and introductions (5 questions)
   - Verb conjugations (10 questions)
   - Daily routines and activities (8 questions)
   - Food and preferences (5 questions)
   - Time and calendar (3 questions)
   - Question formation (4 questions)
   - Personal expression and opinions (8 questions)
   - Describing people, places, things (7 questions)

3. **Question Types:**
   - Simple translation
   - Verb conjugation
   - Sentence translation
   - Open-ended personal questions
   - Question formation
   - Sentence building

4. **Saves to Database:**
   - All questions are saved to the `writing_questions` table
   - Each includes hints, explanations, and acceptable variations
   - Ready for immediate use in the writing-test page

### Expected Output

```
🚀 Starting question generation process...
──────────────────────────────────────────────────

🎯 Generating 50 writing questions...
✅ Generated 50 questions

📊 Question Summary:
──────────────────────────────────────────────────

📈 By Difficulty:
  beginner       : 20 questions
  intermediate   : 15 questions
  advanced       : 15 questions

📝 By Type:
  translation         : 15 questions
  conjugation         : 10 questions
  open_ended          : 12 questions
  question_formation  : 8 questions
  sentence_building   : 5 questions

🎯 Top Topics:
  greetings                    : 5 questions
  verb_conjugation:être        : 4 questions
  daily_routine                : 8 questions
  food                         : 5 questions
  ...

✍️  Require Complete Sentences: 25/50

💾 Saving 50 questions to database...
✅ Successfully saved 50 questions to database

✨ Success! Questions have been generated and saved.

💡 Next steps:
   1. Review questions in your Supabase dashboard
   2. Update writing-test page to load from database
   3. Test the questions with students
```

### Cost Estimate

- Generation: ~$0.30 (Claude Sonnet 4.5, ~8K tokens output)
- One-time cost for 50 high-quality questions

### After Running

1. **Verify in Supabase:**
   - Go to your Supabase dashboard
   - Navigate to `writing_questions` table
   - Verify 50 questions were added

2. **Test the Questions:**
   - Visit `/writing-test` in your app
   - Questions will now load from the database
   - Each refresh gives you a random set of 5 questions

3. **Review and Adjust:**
   - Check if questions align with your curriculum
   - Update `acceptable_variations` for more flexibility
   - Adjust difficulty levels as needed

### Regenerating Questions

If you want to generate a fresh batch:

1. **Clear existing questions** (optional):
   ```sql
   DELETE FROM writing_questions;
   ```

2. **Run the script again:**
   ```bash
   npx tsx scripts/generate-initial-questions.ts
   ```

### Customization

To customize the questions generated, edit the prompt in `generate-initial-questions.ts`:

- Change difficulty distribution
- Add/remove topics
- Adjust question type ratios
- Modify the total count

Example:
```typescript
const prompt = `Generate ${count} French writing practice questions...
- Difficulty distribution: 30 beginner, 15 intermediate, 5 advanced
- Focus heavily on verb conjugations and daily routines
...`;
```

### Troubleshooting

**Error: Missing Supabase credentials**
- Ensure `.env.local` has both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**Error: Missing ANTHROPIC_API_KEY**
- Add `ANTHROPIC_API_KEY` to `.env.local`

**Error saving to database**
- Verify the `writing_questions` table exists
- Check Supabase permissions for the anon key

**Generated fewer than 50 questions**
- Claude may have generated fewer questions
- Check the console output for parsing errors
- Re-run the script
