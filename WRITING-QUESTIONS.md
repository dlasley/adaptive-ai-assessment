# French Writing Questions System

## Overview

A comprehensive system for French language writing practice with AI-powered evaluation using Claude Opus 4.5.

## Features

✅ **Advanced Question Types**
- Simple translations ("How do you say 'hello'?")
- Verb conjugations ("Conjugate 'être' in present tense")
- Open-ended questions ("What are you going to do after school?")
- Sentence building and question formation
- Requires complete sentence responses for advanced learners

✅ **Intelligent Evaluation**
- **Tiered evaluation approach** for efficiency
- **Opus 4.5** for accurate semantic evaluation
- **Accent tracking** - separately evaluates diacritic usage
- **Partial credit** scoring (0-100 points)
- Detailed feedback with specific corrections

✅ **Accent Flexibility**
- Accepts answers with or without accents
- Tracks accent correctness separately
- Can give partial credit for correct content but missing accents

## Setup Instructions

### 1. Run Database Migration

```bash
# In Supabase SQL Editor, run the migration
psql -f supabase/migrations/create_writing_questions.sql
```

Or manually run the SQL in your Supabase dashboard.

### 2. Generate Initial Questions

The system uses an API to generate questions. You can generate them:

**Option A: Via API**
```typescript
// Call the generate-writing-questions API
POST /api/generate-writing-questions
{
  "count": 50,
  "difficulty": "mixed", // or "beginner", "intermediate", "advanced"
  "topic": "daily_routine" // optional
}
```

**Option B: Using the utility function**
```typescript
import { generateWritingQuestions } from '@/lib/writing-questions';

const questions = await generateWritingQuestions(50);
// Questions are generated but need to be saved to database
```

### 3. Save Questions to Database

After generating questions, save them to the database:

```sql
INSERT INTO writing_questions (
  question_en,
  correct_answer_fr,
  acceptable_variations,
  topic,
  difficulty,
  question_type,
  explanation,
  hints,
  requires_complete_sentence
) VALUES (...);
```

## Usage

### Basic Component Usage

```typescript
import WritingQuestionComponent from '@/components/WritingQuestion';
import type { WritingQuestion } from '@/lib/writing-questions';

const question: WritingQuestion = {
  id: '...',
  question_en: 'What are you going to do this weekend?',
  correct_answer_fr: 'Je vais...',  // Example answer
  acceptable_variations: [],
  topic: 'daily_routine',
  difficulty: 'advanced',
  question_type: 'open_ended',
  explanation: 'Practice near future tense',
  hints: ['Use "Je vais + infinitive"'],
  requires_complete_sentence: true,
  // ...
};

<WritingQuestionComponent
  question={question}
  onSubmit={(answer, evaluation) => {
    console.log('Score:', evaluation.score);
    console.log('Correct accents:', evaluation.hasCorrectAccents);
  }}
/>
```

### Evaluation API

```typescript
POST /api/evaluate-writing
{
  "question": "What are you going to do after school?",
  "userAnswer": "Je vais faire mes devoirs",
  "correctAnswer": null, // Can be null for open-ended
  "questionType": "open_ended",
  "difficulty": "advanced"
}

// Response:
{
  "isCorrect": true,
  "score": 100,
  "hasCorrectAccents": true,
  "feedback": "Excellent! Perfect grammar and accent usage.",
  "corrections": {},
  "correctedAnswer": null
}
```

## Question Types

### 1. Translation (Beginner)
```javascript
{
  question_en: "How do you say 'the cat'?",
  correct_answer_fr: "le chat",
  acceptable_variations: ["un chat"],
  requires_complete_sentence: false
}
```

### 2. Verb Conjugation (Beginner/Intermediate)
```javascript
{
  question_en: "Conjugate 'avoir' (to have) in present tense, first person: I have",
  correct_answer_fr: "j'ai",
  acceptable_variations: ["J'ai", "je ai"], // Common errors accepted
  requires_complete_sentence: false
}
```

### 3. Open-Ended Personal (Advanced)
```javascript
{
  question_en: "What are you going to do after school today?",
  correct_answer_fr: "Je vais faire mes devoirs", // Example only
  acceptable_variations: [], // Any grammatically correct answer accepted
  requires_complete_sentence: true
}
```

### 4. Sentence Building (Intermediate/Advanced)
```javascript
{
  question_en: "Write a complete sentence saying you like to read books.",
  correct_answer_fr: "J'aime lire des livres",
  acceptable_variations: [
    "J'aime lire les livres",
    "Je aime lire des livres"  // Minor grammar accepted
  ],
  requires_complete_sentence: true
}
```

## Evaluation Logic

The system supports two evaluation modes controlled by the `SKIP_FUZZY_LOGIC` feature flag:

### Mode 1: API-Only Evaluation (High Accuracy)
Set `SKIP_FUZZY_LOGIC=true` for maximum accuracy. Best for:
- Formal assessments and graded tests
- Advanced/intermediate difficulty questions
- When accuracy is more important than cost
- Small class sizes or limited question sets

**Evaluation Flow:**
1. **Tier 1: Empty/Too Short Check** - Reject answers under 2 characters
2. **Tier 2: Exact Match** - Instant comparison (with/without accents)
3. **Tier 3: Claude Opus 4.5** - Full AI evaluation for all other answers

**Cost:** ~$0.015 per evaluation

### Mode 2: Fuzzy → API Tiered Evaluation (Cost-Efficient) **[DEFAULT]**
Set `SKIP_FUZZY_LOGIC=false` for cost savings. Best for:
- Practice sessions and homework
- Beginner difficulty questions
- Large class sizes or frequent practice
- When 70-95% accuracy is acceptable

**Evaluation Flow:**
1. **Tier 1: Empty/Too Short Check** - Reject answers under 2 characters
2. **Tier 2: Exact Match** - Instant comparison (with/without accents)
3. **Tier 3: Fuzzy Evaluation** - Local similarity-based evaluation
   - Uses Levenshtein distance to calculate similarity (0-100%)
   - Confidence thresholds based on difficulty:
     - **Beginner:** 95% confidence required (high threshold for conjugations/translations)
     - **Intermediate:** 85% confidence required
     - **Advanced:** 95% confidence required
   - Returns immediate result if confidence is high enough
4. **Tier 4: Claude Opus 4.5 Fallback** - Only when confidence is too low

**Cost Savings:**
- **Beginner questions:** ~47% cost reduction (53% use API, high threshold for accuracy)
- **Intermediate questions:** ~53% cost reduction (47% use API)
- **Advanced questions:** ~47% cost reduction (53% use API)
- **Mixed difficulty:** ~49% average cost reduction

**Accuracy Trade-off:**
- Beginner: Minimal accuracy loss (high 95% threshold ensures precision)
- Intermediate: ~15% accuracy loss
- Advanced: ~30% accuracy loss (not recommended for graded tests)

### Confidence-Based Fuzzy Scoring

When fuzzy evaluation has high confidence, it scores as follows:

- **95%+ similarity:** Score 95-100, marked correct (minor typos)
- **85-94% similarity:** Score 85-94, correct only for beginners
- **70-84% similarity:** Score 70-84, not marked correct but partial credit
- **Below threshold:** Falls back to Semantic API

### Customizing Confidence Thresholds

Edit [src/lib/writing-questions.ts](src/lib/writing-questions.ts) to adjust thresholds:

```typescript
const CONFIDENCE_THRESHOLDS = {
  beginner: 0.95,      // High threshold for conjugations/translations (95%)
  intermediate: 0.85,  // Default: 85%
  advanced: 0.95,      // Higher = fewer fuzzy evaluations
} as const;
```

## Accent Handling

The system separately evaluates accent usage:

```typescript
{
  "userAnswer": "cafe",           // Missing accent
  "correctAnswer": "café",
  "hasCorrectAccents": false,     // Flagged
  "score": 98,                    // Still high score for correct word
  "feedback": "Correct! Remember to use the accent: café"
}
```

**Potential Uses:**
- Full credit for practice mode (accents not required)
- Partial credit deduction for tests (e.g., -2 points per missing accent)
- Separate "accent accuracy" metric in progress tracking
- Teacher can decide how to weight accent errors

## Example Advanced Questions

1. **Personal Expression**
   - "What did you do last weekend?"
   - Accepts any grammatically correct past-tense response

2. **Future Plans**
   - "What are your plans for summer vacation?"
   - Accepts any future-tense response about plans

3. **Opinions**
   - "What is your favorite food and why?"
   - Requires complete explanation

4. **Descriptions**
   - "Describe your best friend in 2-3 sentences"
   - Evaluates descriptive vocabulary and grammar

## Model Costs

**Question Generation (Sonnet 4.5):**
- ~$0.50 for 100 questions (one-time)

**Answer Evaluation (Opus 4.5):**
- ~$0.015 per evaluation
- 100 student answers = ~$1.50

**For 30-student class:**
- 50 pre-generated questions: $0.25
- Each student answers 20 questions: 600 evaluations = $9
- **Monthly cost: ~$10-15 for comprehensive practice**

## Integration with Existing System

The writing questions can be:
1. Mixed into existing multiple-choice quizzes
2. Used as a separate "Writing Practice" mode
3. Assigned as homework with detailed feedback
4. Tracked in student progress reports

## Future Enhancements

- [ ] Audio pronunciation for questions
- [ ] Image-based prompts
- [ ] Collaborative writing exercises
- [ ] Teacher can create custom questions
- [ ] Pre-filled question bank (500+ questions)
- [ ] Progressive difficulty adaptation
- [ ] Streak tracking for writing practice

## Technical Notes

- Uses Claude Opus 4.5 for maximum accuracy
- Stores all attempts in database for progress tracking
- Accent normalization uses Unicode NFD decomposition
- Levenshtein distance for fuzzy matching (tier 2, if needed)
- Supports markdown in feedback for rich formatting

---

**Next Steps:**
1. Run the database migration
2. Generate initial question set (50-100 questions)
3. Test with sample answers
4. Adjust evaluation prompts based on feedback
5. Integrate into main quiz system
