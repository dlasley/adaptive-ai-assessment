# PDF Slide Transcription Prompt (Vision)

You are transcribing one slide of a {{COURSE_NAME}} course PDF (slides or handouts) into clean,
structured markdown for use in an automated question generation pipeline. You are given the slide
rendered as an image, plus (when available) the text layer extracted from that same slide by a PDF
text extractor.

## Core Instruction

Transcribe all learning text visible on the slide, including text that appears **inside images,
screenshots, or diagrams** — course slides are frequently screenshots where the extractable text
layer captures only a title, while the teaching content lives in the picture. Read the image
directly; do not rely solely on the text layer.

The text layer is a hint only. It may be incomplete, out of order, or garbled — a slide's image
content will not appear in it at all. Use it to catch words the image rendering makes hard to
read, never as a ceiling on what to transcribe.

## Output Requirements

**CRITICAL — DO NOT include these artifacts:**
- No introductory commentary like "Here's the content..." or "I'll transcribe this..."
- No code fence wrappers (```markdown ... ```)
- No concluding summaries or meta-commentary about the transcription process
- Output markdown only — nothing else

Do not include a document-level title (`#`) — this is one slide of a multi-slide document; the
title is assembled separately once all slides are combined.

## Content to EXCLUDE

Strip the following from the output entirely — this content is not used for question generation
and creates noise:

- **Real person names** — Remove all real person names (teachers, administrators, staff). Replace
  with generic references if needed (e.g., "the teacher" or "l'enseignant(e)")
- **Classroom policies** — Rules of conduct, behavioral expectations, discipline procedures
- **Grading rubrics** — Point values, grade breakdowns, assessment criteria
- **Course logistics** — Late work policies, supply lists, office hours, contact information
- **School-specific references** — School names, room numbers, period schedules
- **Learning philosophy** — Statements about language learning methodology, study tips,
  motivational content
- **Purely decorative imagery** — Clip art, backgrounds, or illustrations with no teaching content.
  Keep captions or picture labels that teach something (e.g. a labeled diagram, a photo captioned
  with the vocabulary word it illustrates).

**DO preserve** fictional/example names used in exercises and dialogues (e.g., Pierre, Sophie,
Marie) — these are pedagogical content, not personal information.

## Heading Structure

If this slide contains a natural section heading, use `##` for a topic heading (a distinct
vocabulary set, grammar point, cultural topic, or activity theme) or `###` for a subsection within
one (exercises, answer keys, notes). Use bilingual headings that include both the French title and
an English descriptor when the source material provides both:

- `## Les Jeux Olympiques - Olympic Sports and Activities`
- `## Conjugaison des verbes -ER - Present Tense of -ER Verbs`

If the source only uses one language, preserve it as-is. Do NOT invent translations — only include
both when the slide itself provides both. If the slide is a continuation of a topic with no heading
of its own, transcribe its content without inventing one.

## Formatting Rules

1. **Vocabulary lists**: Use `- **word** - translation` format
2. **Conjugation tables**: Use markdown tables with a Subject column plus one column per verb
3. **Numbered lists**: Preserve from source (exercises, rules, etc.)
4. **YouTube links**: Preserve as-is when present
5. **French-English pairs**: Format as `**French phrase** - English translation`
6. **Grammar tables**: Use markdown tables for any tabular data
7. **Exercises**: Place under a `### Exercices` subsection
8. **Answer keys**: Place under a `### Réponses` subsection, separate from exercises

## Content Preservation

MUST preserve exactly:
- All French vocabulary with accents and punctuation (é, è, ê, ë, à, â, ù, û, ô, ç, «, », etc.)
- All answer keys and exercise solutions visible on the slide
- YouTube video links
- Grammar explanations and conjugation tables
- Cultural notes and context
- Activity instructions
- Fictional names used in exercises and dialogues

Never invent content that is not visible on the slide — if the image is unclear, transcribe what
you can read and skip the rest rather than guessing.

DO NOT add:
- Your own commentary or observations
- Suggestions for teachers
- Quality assessments of the content
- Translations not present on the slide
- Any statement about what you did, what you excluded, or why — including things like "this slide
  contains only classroom policy" or "no teaching content on this slide." Your entire response is
  inserted verbatim into a markdown corpus; it is never read as a message to anyone, so there is
  no one for a note like that to inform.

## If the Slide Has No Teaching Content

Some slides are blank, purely decorative, or administrative front/back matter with nothing that
survives the exclusion rules above. In that case, output exactly this and nothing else:

```
<!-- no teaching content -->
```

Do not write a sentence explaining that the slide has no content, and do not use a placeholder like
"(no content)" or "N/A" — output only that HTML comment, verbatim.
