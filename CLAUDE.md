# Claude Code Instructions

## Project Overview
French language learning quiz application for French 1 classes. Built with Next.js 15, uses Anthropic Claude API for AI-powered evaluation and Supabase for data persistence.

## Tech Stack
- **Framework**: Next.js 15 (App Router)
- **UI**: React 18, Tailwind CSS
- **AI**: Anthropic Claude API (Opus 4.5 for evaluation)
- **Database**: Supabase (PostgreSQL)
- **Language**: TypeScript

## Key Architecture Patterns

### Question Types
The `Question` type (`src/types/index.ts`) supports:
- `multiple-choice` - Standard MCQ
- `true-false` - Binary choice
- `fill-in-blank` - Single-line typed answer
- `writing` - Multi-line typed answer
- `matching` - Pair matching

### Tiered Evaluation System
For typed-answer questions (fill-in-blank, writing), evaluation follows this fallback chain:
1. **Empty check** - Reject < 2 chars
2. **Exact match** - Normalized comparison (accents stripped, lowercase)
3. **Fuzzy logic** - Levenshtein distance with difficulty-based thresholds
4. **Claude API** - Opus 4.5 fallback for low-confidence cases

See `src/app/api/evaluate-writing/route.ts` for implementation.

### Unified TypedAnswerQuestion Component
`src/components/WritingQuestion/` contains unified components for both fill-in-blank and writing questions:
- `TypedAnswerQuestion` (index.tsx) - Main component, auto-selects variant
- `AnswerInput` - Supports `variant: 'single-line' | 'multi-line'`
- `EvaluationResultDisplay` - Shows results, corrections, superuser metadata
- `QuestionDisplay` - Header with difficulty, topic, type badges
- `QuestionHints` - Progressive hints for superusers

### Data Types
- `Question` (src/types) - Unified quiz question format
- `WritingQuestion` (src/lib/writing-questions.ts) - Database format with snake_case fields
- Use `toQuestion()` helper when converting DB format to component format

## Key Commands
```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run lint         # ESLint
npm run generate-questions  # Generate questions via AI
```

## Important Directories
```
src/
├── app/              # Next.js pages and API routes
│   ├── api/          # API endpoints
│   │   ├── evaluate-writing/   # Tiered evaluation
│   │   └── generate-questions/ # Question generation
│   └── quiz/[unitId]/          # Main quiz page
├── components/
│   └── WritingQuestion/        # Typed answer components
├── lib/              # Utilities
│   ├── question-loader.ts      # Question loading + meta-filtering
│   └── writing-questions.ts    # Evaluation helpers
├── hooks/            # Custom React hooks
└── types/            # TypeScript definitions
```

## Conventions
- Use `Question` type for components, convert from `WritingQuestion` when needed
- Superuser metadata display uses purple color scheme
- All question types should track `evaluationResults` for consistent scoring
- Meta-questions (learning philosophy, teacher info) are filtered at runtime

## Things to Avoid
- Don't add inline evaluation code - use TypedAnswerQuestion component
- Don't create separate handling for fill-in-blank vs writing - they share components
- Don't commit `.claude/settings.local.json` or backup files
- Don't generate meta-questions about learning strategies or teacher info

## Testing Considerations
- Superuser mode shows evaluation metadata (tier used, similarity scores)
- Test both question types use the same Submit button UI
- Verify tiered evaluation fallback works (exact → fuzzy → API)
