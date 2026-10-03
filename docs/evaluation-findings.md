# Evaluation Findings

What the model evaluation framework has concluded so far. How it works, its tables and its commands
are in the [README](../README.md#model-evaluation-framework) and
[`pipeline-architecture.md`](pipeline-architecture.md#evaluation-framework); this page holds only
results.

Unless a section says otherwise, figures were measured in September 2026 on the first unit of the
French II course. The authoritative record is the append-only `eval_findings` table; this page
summarizes it as of 2 October 2026.

## What the results are measured against

The heading-mapping and slide-transcription tasks have reference answers: the correct headings for
40 topics and the correct transcript for 30 slides. Both were checked by an AI agent against the
source material, not by a person, and the course owner corrected two slide references by hand. The
slide references were seeded from the production model's own output before being checked, so the
production transcriber is partly scored against itself.

The audit and answer-grading tasks have no reference answers yet, so their results are reported as
agreement and stability between models, never as accuracy. A human review of reference labels for
both is being arranged.

## Decisions: what changed

**The audit sends one question per call.** Production used to audit questions five per call. Two
repeat runs of Mistral Large 3 with identical groups disagreed on 3.3% of verdicts, but shuffling the
same questions into different groups of five moved 14% to 15%: most of the apparent noise came from
which questions shared a call. With one question per call, two repeat runs disagreed on 2.8%.

| Comparison (Mistral Large 3, 150 questions) | Questions compared | Verdicts that differ |
|---|---|---|
| Groups of five, same groups, run twice | 150 | 5 (3.3%) |
| One per call, run twice | 142 | 4 (2.8%) |
| Groups of five, regrouped differently | 149 | 21 to 22 (14.1% to 14.8%) |
| One per call against groups of five | 143 | 23 (16.1%) |

The 23 disagreements between the two designs were checked once by an AI agent against the course
material, on 26 September 2026: the grouped verdict was wrong on 18 and the single-question verdict
on 3. That check is not stored as reference labels. Both designs cost under a tenth of a cent per
question. Single-question calls brought one new failure: Mistral Large 3 corrupts the question id it
echoes back on about 4% of calls (7 and 6 of 150), which the response parser rejects rather than
misattributes.

**A separate classifier decides which slides to transcribe.** Some slides carry no language content
(course rules, motivation, expectations), and the transcription model kept transcribing them, which
is how a "why learn French" topic reached question generation. Adding a "decide first" paragraph to
the transcription prompt was rejected: Sonnet 5 dropped the right slides but lost content elsewhere
(its share of the reference's words on one teaching slide fell by 0.28, against a per-slide limit of
0.15), and four of the five cheaper models dropped three or four slides where the reference drops
two. A separate yes/no call per slide by Gemini 3.1 Flash-Lite, ahead of the unchanged Sonnet 5
transcription call, was adopted. In two runs it dropped exactly the two slides the reference marks
as non-teaching, captured 97.2% to 97.3% of the reference's words against 90.7% without it, and cost
the same, $0.0082 per slide. A Sonnet 5 classifier made the same decisions at about 1.5 times the
cost. A one-time sweep of all 137 slides on 30 September 2026, outside the run tables, led the course
owner to rule on the slides the classifier disputed, and its prompt was revised to match.

## Decisions: what stayed

**Sonnet 5 stays the heading mapper.** Across three repeats it scored a mean F1 of 0.810 to 0.825
with no unresolvable headings; the rule allowed a candidate at most 0.03 below that. Gemini 2.5 Flash
scored 0.71 to 0.76 with 6 to 8 unresolvable headings per run, GPT-4.1 mini 0.62 to 0.66, Mistral
Large 3 0.63 to 0.64, and Haiku 4.5 0.43 to 0.62.

**Sonnet 5 stays the slide transcriber.** Similarity is a character-level score against the checked
transcript; words captured is the share of the reference's words a transcript contains, which
ignores formatting.

| Model | Similarity (two runs) | Words captured (two runs) | Cost per slide |
|---|---|---|---|
| Sonnet 5 (production) | 0.887, 0.882 | 0.907, 0.914 | $0.0082 |
| Gemini 3.1 Flash-Lite | 0.881, 0.887 | 0.906, 0.899 | $0.0008 |
| Gemini 2.5 Flash | 0.844, 0.827 | 0.895, 0.882 | $0.0007 |
| Haiku 4.5 | 0.837, 0.821 | 0.885, 0.892 | $0.0034 |
| Qwen3-VL 235B | 0.836, 0.823 | 0.899, 0.880 | $0.0005 to $0.0006 |
| Mistral Small 4 | 0.719, 0.722 | 0.785, 0.782 | $0.0004 |

On the mean, Gemini 3.1 Flash-Lite cannot be told apart from Sonnet 5 at this sample size. It fails
the per-slide rule (no slide more than 0.15 below the production model) on three to five slides per
run, including long, dense slides where it leaves out text; some of those failures are on slides
whose reference was seeded from Sonnet 5's output. Each candidate's second run used a prompt
reworded from "page" to "slide", so the two runs are not strict repeats.

## Deferred

**Sonnet 5.5 as the successor transcriber.** On the same 30 slides it matched Sonnet 5 on similarity
(0.884) and cost, captured 0.930 of the reference's words, and was the only Claude model to skip a
non-teaching slide under the current prompt. By words captured, which the rule applies per slide, it
fell more than 0.15 below Sonnet 5 on one slide, an image-only answer key (a per-slide check on 30
September 2026, not stored in the run tables); by character similarity it falls that far on three.
It does not meet the rule; the decision is to revisit when Sonnet 5 approaches retirement or a second
unit of slides exists.

## Observations: recorded, no adoption follows

**Higher image resolution does not help transcription.** At 200 dpi instead of 120, Sonnet 5's words
captured went from 0.907 to 0.898 and Gemini 3.1 Flash-Lite's from 0.906 to 0.896, and Sonnet 5's
cost per slide rose about 46%. Production stays at 120 dpi. The 120 dpi runs were pinned to one host
each and the 200 dpi runs were not.

**A cheap pairwise judge is not a fidelity measure yet.** Gemini 3.1 Flash-Lite, comparing two
transcripts of each slide, preferred Sonnet 5 over Sonnet 5.5 on 11 slides to 4 under its first
prompt and Sonnet 5.5 on 6 to 3 under a revised one, on the same pair of runs. Judged twice under the
revised prompt it agreed with itself on 29 of 30 slides, so the swing came from the wording. Most
non-tie verdicts turned on formatting. The judge now only points a person at slides worth reading.

**Alternative auditors pass more questions than Mistral Large 3.** On a 119-question set, Mistral
Large 3 passed 110 and agreed with its own repeat on 116. Gemini 2.5 Flash, Mistral Small 4, GPT-4.1
mini, Qwen3 235B and DeepSeek V3.2 passed 114 to 118 and agreed with it on 108 to 110. Sonnet 5 passed
111 but agreed on only 104. Without reference labels this shows leniency, not which auditor is right.

**Grading models differ mainly on typos.** On 261 answers seeded by design into classes (correct,
paraphrase, missing accent, typo, partially correct, wrong), every model accepted all designed-correct
answers except Sonnet 5 with reasoning off, at 98%. The share of typo answers accepted ranged from 4%
(Haiku 4.5) to 87% (Opus 5.5, the production grader). Whether a typo should pass is a product
decision the reference review has to settle first. The Opus 5.5 baseline ran without a pinned host;
the candidates were pinned.

**The revised grading prompt moves only borderline scores.** With the rubric in a system message and
the student answer delimited, measured October 2026, Opus 5.5 changed its verdict on 9 and 11 of 254
answers against the old prompt, while its two runs under the new prompt differed from each other on
6. The extra flips were answers near the pass threshold, slightly stricter on typos. Production uses
the new prompt.

## Not yet tested

Question generation and validation have no evaluation runner, so no cheaper generator or validator
has been compared. Experiments for tiered grading (a cheap model first, escalating to Opus) and for
routing auditor disagreements to a person are declared but not run.

## Earlier: Sonnet as an alternative auditor (February 2026)

Before this framework existed, a one-time comparison in February 2026 on a 1,039-question corpus ran
Sonnet alongside Mistral Large as auditor. It has not been repeated, it predates the change to one
question per call, and it cannot be re-derived from the repository or the databases. The two agreed
on 91.2% to 95.9% of verdicts per core criterion. At the question level, Mistral flagged 476
questions Sonnet passed on every criterion, and Sonnet flagged 34 that Mistral passed; part of that
gap is that Mistral checks two criteria Sonnet does not. On the same corpus `difficulty_appropriate`
failed 41.0% of questions and `variations_valid` 22.6%, which is why neither gates a question.
