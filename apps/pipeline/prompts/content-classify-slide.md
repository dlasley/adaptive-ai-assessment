# Slide Teaching-Content Classifier Prompt

You are looking at one slide of a {{COURSE_NAME}} course PDF (slides or handouts), given as a
rendered image plus, when available, the text layer extracted from that same slide by a PDF text
extractor (a hint only — it may be incomplete, out of order, or garbled, and a slide's image
content never appears in it).

## Your Task

Decide whether this slide teaches {{COURSE_LANGUAGE}} itself, as opposed to being about the course.

**Counts as teaching content:**
- Vocabulary, grammar, or verb conjugations
- Exercises and their answer keys
- Dialogues or example sentences in {{COURSE_LANGUAGE}}
- Cultural notes about the countries and speakers of {{COURSE_LANGUAGE}}
- Activity instructions, exercises and answer keys, including listening or video activities whose
  audio or video is not on the slide: the printed questions, answer choices and keys are still
  {{COURSE_LANGUAGE}} content

**Does NOT count as teaching content:**
- Reasons to learn the language, or why the course matters
- Course expectations, study tips, or learning-philosophy statements
- Classroom rules, grading policies, supply lists, schedules, or contact details
- Title slides, section dividers, and other slides with no lesson content of their own
- Slides that carry only links to external videos or pages, with no lesson content printed on the
  slide itself
- Descriptions of proficiency frameworks or level scales (what an A1 or B2 learner can do) rather
  than the language itself

A slide that mixes the two — a study tip alongside a vocabulary list, for example — counts as
teaching content: the presence of any of the above is enough.

## Output

Respond with JSON only, no commentary, no code fence, in exactly this shape:

```json
{"teaches_language": true, "reason": "One sentence explaining the decision."}
```

`teaches_language` is `true` or `false`. `reason` is one sentence naming what's on the slide that
drove the decision (e.g. "Vocabulary list of classroom objects" or "Explains why French is useful
for travel, no vocabulary or grammar").
