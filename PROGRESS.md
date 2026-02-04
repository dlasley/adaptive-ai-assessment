# Progress Tracker

## Current Branch
`feature/writing-questions-qr-refactoring`

## Last Session Summary
**Date**: 2026-02-02

### Completed Work

#### 1. Practice/Assessment Quiz Modes (Not Committed)
- Added Quiz Mode selection to homepage (Practice vs Assessment)
- Assessment mode: 50/50 fill-in-blank and writing questions only
- Practice mode: Mix of all question types (MC 35%, T/F 15%, Fill-in 20%, Writing 30%)
- Mode-aware styling: amber/orange theme for Assessment mode
- Added warnings when fewer questions available than requested
- New files:
  - `src/lib/quiz-modes.ts` - Mode configuration and type distribution

#### 2. Superuser Override Feature (Not Committed)
- Hidden feature: add `?superuser=true` or `?superuser=false` to any URL
- Override persists in sessionStorage until tab is closed
- Re-checks superuser status on each question load
- Designed for future migration to database storage
- New files:
  - `src/lib/superuser-override.ts` - Override utility module
- Modified files:
  - `src/app/quiz/[unitId]/page.tsx` - URL param detection, status re-check
  - `src/app/api/evaluate-writing/route.ts` - Accept override parameter
  - `src/lib/writing-questions.ts` - Pass override to API
  - `src/hooks/useQuestionEvaluation.ts` - Pass override through hook
  - `src/components/WritingQuestion/index.tsx` - Get override from sessionStorage

#### 3. Tiered Evaluation for Fill-in-Blank (Committed: b05045d)
- Fill-in-blank questions now use same 4-tier evaluation as writing questions
- Added superuser metadata display showing evaluation tier, similarity scores
- Improved logging in question generation and selection

#### 2. Meta-Question Cleanup (Committed: 2bef3b0)
- Removed 31 meta-questions (learning philosophy, teacher info)
- Added `isMetaQuestion()` runtime filter in question-loader.ts
- Updated generation scripts to prevent future meta-questions
- See META-QUESTION-CLEANUP.md for details

#### 3. UI Refactoring (Committed)
Unified fill-in-blank and writing question components:

| Old Component | New Component | Changes |
|---------------|---------------|---------|
| `WritingAnswerInput` | `AnswerInput` | Added `variant` prop for single/multi-line |
| `WritingQuestionDisplay` | `QuestionDisplay` | Accepts unified `Question` type |
| `WritingQuestionHints` | `QuestionHints` | Simplified to `hints: string[]` |
| `WritingEvaluationResult` | `EvaluationResultDisplay` | Handles both question types |
| `WritingQuestionComponent` | `TypedAnswerQuestion` | Auto-selects variant by type |

**Impact**:
- Quiz page reduced by 124 lines (removed inline fill-in-blank code)
- Both question types now share Submit button UI
- Backward compatibility aliases exported for all renamed components
- Local testing passed

## Uncommitted Changes
- Quiz modes feature (Practice vs Assessment)
- Superuser override feature (`?superuser=true/false`)
- Question selection with type distribution

## Pending Items
- [ ] Consider renaming component files (e.g., WritingAnswerInput.tsx → AnswerInput.tsx)

## Known Issues
- None currently

## Next Steps (Suggested)
1. ✅ Consider if results page needs similar unification for metadata display
2. ❌ File renaming for component files (optional, aliases work for now)
3. ✅ Break the Progress screen into grouped tabs
4. I want to be able to easily regenerate the app with new material as it becomes available
5. Allow superusers to define question type and difficulty mix?
6. ✅ TOP PRIORITY: Allow users to select their quiz in practice mode or assessment mode.
Create a new user onboarding runthrough sequence.
7. Add appropriate effect animations to milestone events.
8. ❌ The Intermediate level should include an appropriate mix of Beginner questions, and the Advanced level should include an appropriate level of Beginner and Intermediate questions.
9. Adaptive Testing and Spaced Repetition (ask Gemini): In student assessment and testing design, in which a student may be randomly presented with a test drawn from a pool of available questions, and may retake a test multiple times, are there known methods or schemes to represent them with questions that they recently got wrong to reinforce learnings? And then diminish these questions weighting in the random selection as they demonstrate mastery?
10. ✅ This is correct French typography behavior. In French, there must be a space before ?, !, :, and ;. "Quelle heure est-il ?" -- Jackson says it doesn't matter.
11. Figure out how to score partially correct typed responses
12. ✅ Check to see if user is still superuser at each quiz question
13. ✅ Group the content in the Progress page and the Quiz & Assessment conclusion pages into tabs.
14. Add x second delay to moving to the next question to encnourage reading the feedback on wrong or poor answers. Especially text input answers.
15. ✅ Remove the help text from the fill in blank questions, and maybe the written questions. Some of them explicitly give away the answers.
16. ✅ Change db password in .env.local
17. Some questions are in French, such as "Lequel de ces énoncés utilise correctement 'préférer'?"


---

## How to Update This File
At the end of each session, update:
1. **Last Session Summary** - What was done
2. **Uncommitted Changes** - Current working state
3. **Pending Items** - What's left to do
4. **Next Steps** - Recommendations for future sessions
