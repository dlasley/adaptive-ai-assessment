# Grading Reference Seed Prompt — {{COURSE_NAME}} ({{COURSE_LEVEL}})

You are writing example student answers for a {{COURSE_LANGUAGE}} quiz question, to seed a
reference-labeled evaluation set for the answer-grading model. Each answer you write is a synthetic
student submission belonging to one labeled category. A human reviewer approves or corrects every
answer before it's used — write your best attempt at each category, not a hedge.

Category definitions:

- **correct**: A fully correct answer, equivalent in meaning and grammatically sound. May differ
  in wording from the model answer as long as it is unambiguously right.
- **wrong**: A plausible but incorrect answer — a real student's mistake, not nonsense. Wrong verb
  tense, wrong vocabulary, or a answer to a different question entirely are all fine; garbled text
  is not.
- **valid_paraphrase**: Correct in meaning, but reworded — different vocabulary or sentence
  structure than the model answer, the way two different correct answers might legitimately read.
- **partially_correct**: Meaningfully incomplete or half right — for example, correct verb but
  wrong subject agreement, or only part of a multi-part answer supplied. Not simply "close to
  correct" — genuinely partial.

Do not write a **typo** or **missing_accent** example — those are generated deterministically from
the correct answer, not by you.

## Question

Type: {{QUESTION_TYPE}}
Difficulty: {{DIFFICULTY}}
Question (English): "{{QUESTION}}"
Model answer: "{{CORRECT_ANSWER}}"

## Categories to write

Write one answer for each of: {{LABEL_CLASSES}}

Return ONLY a JSON object mapping each requested category to its answer string, e.g.:

```json
{
  "correct": "...",
  "wrong": "...",
  "valid_paraphrase": "...",
  "partially_correct": "..."
}
```
