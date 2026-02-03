# Recent Changes

## Major Updates

### 1. Pre-Generated Questions (No API Key Needed for Students!)

**What Changed:**
- Questions are now pre-generated and stored as JSON files
- Students no longer trigger API calls when taking quizzes
- Zero ongoing API costs during student use

**Technical Details:**
- Added question generation script: `npm run generate-questions`
- Creates 1,000-1,500 questions across all units and difficulty levels
- Stores in `data/questions.json` and per-unit files
- One-time generation cost: ~$10-15

**Benefits:**
- ✅ Faster quiz loading (no API latency)
- ✅ Predictable, zero ongoing costs
- ✅ Questions can be reviewed and curated
- ✅ Works offline once generated

### 2. Improved User Experience

**New Home Page:**
- Defaults to "All Units" practice (comprehensive review)
- Dropdown to optionally filter by specific unit
- Streamlined configuration: unit, questions (5-20), difficulty
- Single "Start Practice" button

**Before:**
```
Home → Choose Unit → Choose Topic → Configure → Start
```

**After:**
```
Home → Configure (optional unit filter) → Start
```

**Benefits:**
- ⚡ Faster to start practicing
- 🎯 Better for comprehensive review
- 📚 Mixes questions from all topics by default

### 3. Quiz Interface Updates

**Changes:**
- Removed topic selection requirement
- Shows unit context in quiz header
- "Practice Again" button returns to home
- "Retry Quiz" button regenerates same configuration

**Display:**
- Quiz now shows: "All Units" or specific unit name
- Includes difficulty level in header
- Topic shown when relevant

## How to Use the New System

### First Time Setup

1. **Generate Questions** (one-time, ~20-30 minutes):
   ```bash
   npm run generate-questions
   ```

2. **Start the App**:
   ```bash
   npm run dev
   ```

3. **Practice!** Go to http://localhost:3000

### For Students

1. Open the app
2. Optionally select a specific unit (or keep "All Units")
3. Choose number of questions (5-20)
4. Select difficulty level
5. Click "Start Practice Session"

## File Structure Changes

### New Files

```
data/
├── questions.json              # All questions (1,000-1,500)
├── questions-introduction.json # Introduction unit questions
├── questions-unit-2.json       # Unit 2 questions
└── questions-unit-3.json       # Unit 3 questions

scripts/
└── generate-questions.ts       # Generation script

src/lib/
└── question-loader.ts          # Question loading utilities
```

### Modified Files

- `src/app/page.tsx` - New streamlined home page
- `src/app/quiz/[unitId]/page.tsx` - Updated for "all units" mode
- `src/app/api/generate-questions/route.ts` - Now loads from JSON
- `src/types/index.ts` - Added fields to Question interface
- `package.json` - Added generation script

## Migration Guide

If you were using the old API-based system:

### Before (API-based):
```typescript
// Required API key in .env.local
ANTHROPIC_API_KEY=sk-ant-...

// Cost per quiz: $0.01-0.02
// Runtime: 5-10 seconds (API latency)
```

### After (Pre-generated):
```typescript
// API key only needed for generation
// Already generated, so no key needed

// Cost per quiz: $0.00
// Runtime: < 1 second (loads from JSON)
```

## Cost Comparison

### Old System (API-based)
- Setup: Free
- Per quiz: $0.01-0.02
- 30 students × 3 quizzes/week × 4 weeks = $3.60-7.20/month

### New System (Pre-generated)
- Setup: $10-15 (one-time generation)
- Per quiz: $0.00
- Unlimited quizzes: $0/month after generation

**Break-even**: ~500-1,500 quizzes

## Troubleshooting

### "No questions available" error

**Solution**: Run the generation script:
```bash
npm run generate-questions
```

### Generation fails

**Common causes**:
1. Invalid API key - check `.env.local`
2. API rate limits - script includes delays
3. Network issues - check internet connection

**Quick fix**:
```bash
# Verify API key is set
cat .env.local | grep ANTHROPIC_API_KEY

# Re-run generation
npm run generate-questions
```

### Questions seem repetitive

The app randomly selects from the question bank. With 1,000+ questions and random selection, you shouldn't see many repeats. If you do:

1. Generate more questions (increase `QUESTIONS_PER_TOPIC_PER_DIFFICULTY` in script)
2. Check that generation completed successfully
3. Verify all JSON files were created in `data/` directory

## Future Enhancements

Possible improvements:

- [ ] Question analytics (track which questions are hardest)
- [ ] Spaced repetition algorithm
- [ ] Custom question uploads
- [ ] Export results to CSV
- [ ] Student progress dashboard
- [ ] Question difficulty adjustment based on performance

## Rollback Instructions

To revert to the API-based system:

1. Restore `src/app/api/generate-questions/route.ts` from git history
2. Restore `src/app/page.tsx` from git history
3. Delete `src/lib/question-loader.ts`
4. Delete `data/` directory

```bash
git checkout HEAD~1 src/app/api/generate-questions/route.ts
git checkout HEAD~1 src/app/page.tsx
rm -rf data/
rm src/lib/question-loader.ts
```

---

## Quiz Modes

The app now supports multiple quiz modes with configurable question type distributions.

### Practice Mode (Default)
Mixed question types for learning and review:
- Multiple choice: 35%
- True/False: 15%
- Fill-in-blank: 20%
- Writing: 30%

### Assessment Mode
Written responses only - simulates classroom assessments:
- Fill-in-blank: 50%
- Writing: 50%

**How to use:**
Add `&mode=assessment` to the quiz URL, or select from the home page (if mode selector is enabled).

```
http://localhost:3000/quiz/all?num=10&difficulty=beginner&mode=assessment
```

**Configuration:**
Mode definitions are in `src/lib/quiz-modes.ts`. Easy to add new modes or adjust distributions.

---

## Hidden/Developer Features

### Superuser Mode

Superuser mode displays additional metadata on typed-answer questions (fill-in-blank and writing), including:
- Evaluation tier used (exact match, fuzzy logic, Semantic API)
- Similarity scores and confidence levels
- Question metadata (type, difficulty, topic)

**Ways to enable/disable superuser mode:**

#### 1. URL Parameter (for initial load)
Add `?superuser=true` or `?superuser=false` to any quiz URL:
```
http://localhost:3000/quiz/all?num=10&difficulty=beginner&superuser=true
```
Note: Changing the URL mid-quiz will reset quiz progress.

#### 2. Console Command (mid-quiz, no reset)
Open browser DevTools console and run:
```javascript
window.setSuperuser(true)   // Enable superuser mode
window.setSuperuser(false)  // Disable superuser mode
```
Changes take effect on the next question submission.

#### 3. Keyboard Shortcut (mid-quiz, no reset)
Press `Ctrl+Shift+S` (or `Cmd+Shift+S` on Mac) to toggle superuser mode.
A brief notification will appear confirming the new state.

**Persistence:**
- Superuser override persists in sessionStorage until the tab is closed
- The override takes precedence over database-based superuser status

---

## Questions?

- Check `README.md` for basic setup
- Check `SETUP.md` for detailed instructions
- Review this file for what changed
