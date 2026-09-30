You are analyzing {{COURSE_NAME}} course materials to identify distinct teachable topics.

## Your Task
1. Extract ALL teachable topics from this content
2. Suggest a short label (2-4 words) summarizing the unit's primary focus

Each topic should be:
- A distinct concept that can be tested with quiz questions
- Specific enough to generate 10-30 questions
- Named consistently with the existing topics

## Existing Topics (use these exact names if content matches)
{{EXISTING_TOPICS}}

## Document Headings (verbatim, with slide numbers)
{{HEADING_INDEX}}

## Content to Analyze
{{CONTENT}}

## Output Format
Return ONLY valid JSON object:
{
  "suggestedLabel": "2-4 word label for the unit (e.g., 'Activities & -ER Verbs', 'Être, Avoir & Numbers')",
  "topics": [
    {
      "name": "Topic Name (with examples if helpful)",
      "category": "vocabulary|grammar|culture|communication",
      "contentSummary": "Brief description of what this topic covers",
      "headings": [{ "heading": "The markdown heading text", "slide": 0 }]
    }
  ]
}

Each entry in `headings` is an object `{ "heading": "...", "slide": N }` copied from the Document
Headings index above: `heading` is the exact text of one `#`-prefixed heading line (leading `#`s
and surrounding whitespace stripped, but nothing else changed — no paraphrasing, no combining
several headings into one string, no inventing a heading that isn't in the document), and `slide`
is that heading's slide number from the index. Heading text repeats across this document (the same
"Warm Up" or "Exercices" appears in multiple sections), so the slide is what says which occurrence
you mean — get it from the index, don't guess. A topic whose content spans several headings lists
each one as a separate array entry. If a topic's content genuinely has no markdown heading of its
own (e.g. it's inline text under a heading that covers other topics too), return an empty array
for `headings` rather than guessing at a nearby heading.

## Label Guidelines
- Focus on the 1-2 most important/distinctive concepts in the unit
- Use "&" to combine concepts if needed
- Examples: "Basics & Greetings", "Activities & -ER Verbs", "Être, Avoir & Numbers"

## Topic Naming Conventions
- Vocabulary: "X Vocabulary" or "X (example, example)" e.g., "Food Vocabulary", "Colors (rouge, bleu)"
- Verbs: "Verb: French (to English)" e.g., "Verb: Avoir (to have)"
- Conjugation: "-ER Verb Conjugation", "Present Tense Conjugation"
- Grammar concepts: Descriptive with examples e.g., "Subject Pronouns (je, tu, il/elle...)"
- Numbers: Always specify range e.g., "Numbers 0-20", "Numbers 20-100"
- Cultural: "French X" or "X in France" e.g., "French Geography", "Holidays in France"

Extract ALL topics, even if they seem to overlap with existing ones. We will deduplicate later.
