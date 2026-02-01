/**
 * Custom hook for video recommendations based on quiz results
 * Reusable across different quiz types
 */

import { useMemo } from 'react';
import { getRecommendedVideos, type VideoResource } from '@/lib/video-resources';
import type { QuizResult } from './useQuizProgress';

export interface UseVideoRecommendationsProps<T> {
  results: QuizResult[];
  questions: T[];
  getTopicFromQuestion: (question: T, index: number) => string;
  maxVideos?: number;
}

export function useVideoRecommendations<T>({
  results,
  questions,
  getTopicFromQuestion,
  maxVideos = 6
}: UseVideoRecommendationsProps<T>): VideoResource[] {
  return useMemo(() => {
    if (results.length === 0) return [];

    // Collect topics from all questions, prioritizing incorrect ones
    const incorrectTopics = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => !result.evaluation.isCorrect)
      .map(({ index }) => getTopicFromQuestion(questions[index], index));

    const allTopics = questions.map((q, idx) => getTopicFromQuestion(q, idx));

    // Get videos for incorrect topics first, then all topics
    const topics = incorrectTopics.length > 0 ? incorrectTopics : allTopics;

    return getRecommendedVideos(topics, undefined, maxVideos);
  }, [results, questions, getTopicFromQuestion, maxVideos]);
}
