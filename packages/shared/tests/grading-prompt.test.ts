import { describe, expect, it } from 'vitest';
import {
  buildEvaluationPrompt,
  parseEvaluationResponse,
  EvaluationParseError,
  GRADING_CALL_SETTINGS,
} from '../src/grading-prompt';

describe('buildEvaluationPrompt', () => {
  it('renders a stable prompt for a fixed set of inputs', () => {
    // Pinned via toMatchSnapshot — the committed .snap file is the fixture, so an edit to this
    // builder that changes what gets sent to the model shows up as a snapshot diff in review.
    const prompt = buildEvaluationPrompt({
      question: 'Translate: hello',
      userAnswer: 'Bonjuor',
      correctAnswer: 'Bonjour',
      questionType: 'translation',
      difficulty: 'beginner',
      correctnessThreshold: 70,
    });
    expect(prompt).toMatchSnapshot();
  });

  it('renders the open-ended completeness line and omits Expected Answer when correctAnswer is unset', () => {
    const prompt = buildEvaluationPrompt({
      question: 'Describe your weekend',
      userAnswer: 'Ce week-end, je suis allé au parc.',
      correctAnswer: undefined,
      questionType: 'open_ended',
      difficulty: 'advanced',
      correctnessThreshold: 70,
    });
    expect(prompt).toContain('This is an open-ended question with multiple acceptable answers.');
    expect(prompt).toContain('Is it a complete, coherent sentence/response?');
    expect(prompt).not.toContain('Expected Answer:');
  });

  it('interpolates correctnessThreshold into the isCorrect instruction', () => {
    const prompt = buildEvaluationPrompt({
      question: 'q',
      userAnswer: 'a',
      correctAnswer: 'a',
      questionType: 'translation',
      difficulty: 'beginner',
      correctnessThreshold: 85,
    });
    expect(prompt).toContain('true if score >= 85');
  });
});

describe('GRADING_CALL_SETTINGS', () => {
  it('matches the settings evaluate-writing/route.ts used before extraction', () => {
    expect(GRADING_CALL_SETTINGS).toEqual({ temperature: 0.3, maxTokens: 4096, jsonMode: true });
  });
});

describe('parseEvaluationResponse', () => {
  const valid = {
    isCorrect: true,
    score: 90,
    hasCorrectAccents: true,
    feedback: 'ok',
    corrections: {},
    confidenceScore: 95,
  };

  it('parses a well-formed JSON response', () => {
    expect(parseEvaluationResponse(JSON.stringify(valid))).toEqual(valid);
  });

  it('strips markdown code fences before parsing', () => {
    expect(parseEvaluationResponse('```json\n' + JSON.stringify(valid) + '\n```')).toEqual(valid);
  });

  it('throws EvaluationParseError on invalid JSON', () => {
    expect(() => parseEvaluationResponse('not json')).toThrow(EvaluationParseError);
  });

  it('throws EvaluationParseError when isCorrect/score/feedback are missing', () => {
    const { feedback: _feedback, ...missingFeedback } = valid;
    expect(() => parseEvaluationResponse(JSON.stringify(missingFeedback))).toThrow(EvaluationParseError);
  });

  it('throws EvaluationParseError when score is out of the 0-100 range', () => {
    expect(() => parseEvaluationResponse(JSON.stringify({ ...valid, score: 150 }))).toThrow(EvaluationParseError);
  });
});
