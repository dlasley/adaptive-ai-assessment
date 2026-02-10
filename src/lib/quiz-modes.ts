/**
 * Quiz Mode Configuration
 * Defines available quiz modes and their question type distributions
 */

import { Question } from '@/types';

export type QuizMode = 'practice' | 'assessment';

export interface QuizModeConfig {
  id: QuizMode;
  label: string;
  description: string;
  allowedTypes: Question['type'][];
  /** Distribution ratios for each type (should sum to 1.0) */
  typeDistribution: Partial<Record<Question['type'], number>>;
}

/**
 * Quiz mode configurations
 * Easy to modify distributions here
 */
export const QUIZ_MODES: Record<QuizMode, QuizModeConfig> = {
  practice: {
    id: 'practice',
    label: 'Practice Mode',
    description: 'Mixed question types for learning and review',
    allowedTypes: ['multiple-choice', 'true-false', 'fill-in-blank', 'writing'],
    typeDistribution: {
      'multiple-choice': 0.35,
      'true-false': 0.15,
      'fill-in-blank': 0.20,
      'writing': 0.30,
    },
  },
  assessment: {
    id: 'assessment',
    label: 'Assessment Mode',
    description: 'Written responses only - simulates classroom assessments',
    allowedTypes: ['fill-in-blank', 'writing'],
    typeDistribution: {
      'fill-in-blank': 0.50,
      'writing': 0.50,
    },
  },
};

/**
 * Get the default quiz mode
 */
export function getDefaultMode(): QuizMode {
  return 'practice';
}

/**
 * Get mode configuration by ID
 */
export function getModeConfig(mode: QuizMode): QuizModeConfig {
  return QUIZ_MODES[mode] || QUIZ_MODES.practice;
}