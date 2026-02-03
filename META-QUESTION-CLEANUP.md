# Meta-Question Cleanup & Prevention

## Summary

Removed 31 meta-questions from the question bank and implemented safeguards to prevent future meta-questions from appearing in quizzes.

## What Are Meta-Questions?

Meta-questions are questions that test knowledge about:
- **Learning philosophy**: "Making mistakes is part of the learning process"
- **Study strategies**: "What is the most important factor for success?"
- **Teacher information**: Personal details about instructors (Mr. , etc.)
- **Course administration**: Classroom rules, grading policies, etc.

These questions don't assess actual French language competency (grammar, vocabulary, culture, communication).

## Changes Made

### 1. Cleaned Existing Questions (31 removed)

**File**: `data/questions.json`
- **Before**: 1,132 questions
- **After**: 1,101 questions
- **Removed**: 31 meta-questions
- **Backup**: `data/questions.json.backup-[timestamp]`

#### Categories of Removed Questions:

**Learning Philosophy Questions (13):**
- Questions about "making mistakes" encouraging/discouraging learners
- Questions about "language acquisition principles"
- Questions about "growth mindset"
- Questions about "willingness to learn"
- Questions about "effort and success" relationships

**Personal Teacher Questions (17):**
- How many languages does Mr.  speak?
- How long has Mr.  lived in France?
- What are Mr. 's hobbies/interests?
- Questions about Mr. 's books, marathon, favorite cartoons, etc.

**Question about course materials (1):**
- "Je _____ ma volonté d'apprendre" (testing concept of "willingness to learn")

### 2. Runtime Filtering Added

**File**: `src/lib/question-loader.ts`

Added `isMetaQuestion()` filter function that automatically removes meta-questions when loading:
- Checks question text and explanations against meta-patterns
- Applied in `loadAllQuestions()` and `loadUnitQuestions()`
- Logs filtered questions in development mode

**Detected Patterns:**
```typescript
- /making mistakes.*(discourage|should|part of learning)/i
- /language acquisition/i
- /growth mindset/i
- /willingness to learn/i
- /learning process/i
- /most important factor.*success/i
- /mr\.\s+/i
- /teacher.*lived|interests|hobbies/i
- And more...
```

### 3. Question Generation Improvements

**File**: `scripts/generate-questions.ts`

Enhanced AI prompt with explicit instructions to avoid:
- Learning philosophy meta-questions
- Teacher personal information
- Course administration details
- Study strategies and motivation concepts

Added post-generation validation:
- `isMetaQuestion()` filter runs on all generated questions
- Meta-questions are removed before saving
- Console warning if any are filtered out

## Verification

```bash
# Verify no meta-questions remain
cat data/questions.json | jq '[.[] | select(.question | test("Making mistakes.*discourage"; "i"))] | length'
# Result: 0

cat data/questions.json | jq '[.[] | select(.question | test("Mr\\. "; "i"))] | length'
# Result: 0
```

## Impact

✅ **Quiz Quality**: Questions now focus exclusively on French language skills
✅ **Student Experience**: No confusing questions about learning philosophy
✅ **Future Prevention**: Multi-layer protection against new meta-questions
✅ **Backward Compatible**: No breaking changes to existing functionality

## Example Removed Questions

**Before (Meta-Question):**
```json
{
  "id": "introduction_Days_of_the_Week_intermediate_q9",
  "question": "True or False: Making mistakes in French language learning should discourage you from continuing to try.",
  "type": "true-false",
  "correctAnswer": "Faux",
  "explanation": "The materials clearly state that mistakes are part of learning..."
}
```

**Replaced With**: Question bank now contains only French language content questions like:
- Verb conjugations
- Vocabulary translations
- Grammar rules
- Cultural knowledge
- Practical communication skills

## Rollback Instructions

If needed, restore the original questions:
```bash
# Find the backup file
ls -la data/questions.json.backup-*

# Restore from backup
cp data/questions.json.backup-[timestamp] data/questions.json
```

## Next Steps

1. ✅ Meta-questions removed from question bank
2. ✅ Runtime filtering implemented
3. ✅ Generation scripts updated
4. 🔄 Monitor logs for any filtered questions in development
5. 🔄 Review new generated questions periodically

## Testing

To test the filtering in development:
1. Start dev server: `npm run dev`
2. Create a quiz and check console logs
3. Look for: `🚫 Filtered out N meta-questions` (should show 0)
