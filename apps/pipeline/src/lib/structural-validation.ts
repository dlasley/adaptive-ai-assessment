/**
 * Structural validation for generated questions — fast, no-API-call checks that
 * reject obviously malformed questions before they reach AI answer validation.
 * The only gate between AI-generated questions and the `pending` quality queue.
 */

import type { QuestionType } from '@adaptive/shared/enums';

export interface StructuralQuestion {
  question: string;
  type: QuestionType;
  options?: string[];
  correctAnswer: string;
}

export interface StructuralRejection<T> {
  question: T;
  reason: string;
}

export function structuralValidation<T extends StructuralQuestion>(
  questions: T[]
): { valid: T[]; rejected: StructuralRejection<T>[] } {
  const valid: T[] = [];
  const rejected: StructuralRejection<T>[] = [];

  for (const q of questions) {
    switch (q.type) {
      case 'multiple-choice':
        if (!q.options || q.options.length !== 4) {
          rejected.push({ question: q, reason: 'MCQ must have exactly 4 options' });
        } else if (!q.options.includes(q.correctAnswer)) {
          rejected.push({ question: q, reason: 'MCQ correctAnswer not in options' });
        } else if (new Set(q.options).size !== q.options.length) {
          rejected.push({ question: q, reason: 'MCQ has duplicate options' });
        } else {
          valid.push(q);
        }
        break;
      case 'true-false':
        if (!q.options || !['Vrai', 'Faux'].every(o => q.options!.includes(o))) {
          rejected.push({ question: q, reason: 'T/F options must be ["Vrai", "Faux"]' });
        } else if (!['Vrai', 'Faux'].includes(q.correctAnswer)) {
          rejected.push({ question: q, reason: 'T/F correctAnswer must be Vrai or Faux' });
        } else {
          valid.push(q);
        }
        break;
      case 'fill-in-blank': {
        const blankCount = (q.question.match(/_{3,}/g) || []).length;
        // For multi-blank: count comma-separated groups instead of space-separated words
        const answerGroups = blankCount > 1
          ? q.correctAnswer.split(',').map(g => g.trim()).filter(Boolean)
          : [q.correctAnswer.trim()];
        if (!q.question.includes('_____')) {
          rejected.push({ question: q, reason: 'Fill-in-blank must contain _____' });
        } else if (q.correctAnswer.length < 1) {
          rejected.push({ question: q, reason: 'Fill-in-blank answer is empty' });
        } else if (blankCount > 1 && answerGroups.length !== blankCount) {
          rejected.push({ question: q, reason: `Fill-in-blank has ${blankCount} blanks but ${answerGroups.length} comma-separated answer groups` });
        } else {
          valid.push(q);
        }
        break;
      }
      case 'writing':
        if (q.correctAnswer.length < 5) {
          rejected.push({ question: q, reason: 'Writing answer too short (<5 chars)' });
        } else {
          valid.push(q);
        }
        break;
      default:
        valid.push(q);
    }
  }

  // Cross-type check: explicit answer labels leaked into question text
  for (let i = valid.length - 1; i >= 0; i--) {
    const q = valid[i];
    if (/\(\s*(answer|réponse|response)\s*:/i.test(q.question)) {
      rejected.push({ question: valid.splice(i, 1)[0], reason: 'Explicit answer label in question text' });
    }
  }

  return { valid, rejected };
}
