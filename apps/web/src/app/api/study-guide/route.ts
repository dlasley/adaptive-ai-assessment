import { NextRequest, NextResponse } from 'next/server';
import { supabase, isSupabaseAvailable } from '@/lib/supabase';
import { MAX_QUESTIONS } from '@/lib/api-schemas';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('study-guide');

interface IncorrectQuestion {
  topic: string;
  unitId: string;
}

interface TopicRecommendation {
  topic: string;
  count: number;
  resources: { url: string; title: string }[];
}

export async function POST(request: NextRequest) {
  try {
    const { incorrectQuestions } = await request.json() as { incorrectQuestions: IncorrectQuestion[] };

    if (!incorrectQuestions || incorrectQuestions.length === 0) {
      return NextResponse.json({ recommendations: [] });
    }

    // Bounded to the same per-quiz question cap enforced on quiz submission —
    // this list is derived from one quiz's questions, so it can never
    // legitimately exceed that ceiling.
    if (!Array.isArray(incorrectQuestions) || incorrectQuestions.length > MAX_QUESTIONS) {
      return NextResponse.json({ error: 'Too many incorrect questions' }, { status: 400 });
    }

    // Group incorrect questions by topic
    const topicCounts: Record<string, { count: number; unitId: string }> = {};

    for (const q of incorrectQuestions) {
      if (!topicCounts[q.topic]) {
        topicCounts[q.topic] = { count: 0, unitId: q.unitId };
      }
      topicCounts[q.topic].count++;
    }

    // Sort topics by number of incorrect answers (descending)
    const sortedTopics = Object.entries(topicCounts)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 5); // Top 5 topics to focus on

    // Query learning resources from the database
    const recommendations: TopicRecommendation[] = [];

    if (isSupabaseAvailable()) {
      const topics = sortedTopics.map(([topic]) => topic);
      const unitIds = [...new Set(sortedTopics.map(([, data]) => data.unitId))];

      const { data: resources, error } = await supabase!
        .from('learning_resources')
        .select('topic, url, title')
        .in('topic', topics)
        .in('unit_id', unitIds)
        .eq('quality_status', 'active')
        .order('title');

      if (error) {
        logger.error('Error fetching learning resources', supabaseErrorFields(error));
      }

      // Group resources by topic
      const resourcesByTopic = new Map<string, { url: string; title: string }[]>();
      for (const r of resources || []) {
        const existing = resourcesByTopic.get(r.topic) || [];
        existing.push({ url: r.url, title: r.title });
        resourcesByTopic.set(r.topic, existing);
      }

      for (const [topic, data] of sortedTopics) {
        const topicResources = resourcesByTopic.get(topic) || [];
        recommendations.push({
          topic,
          count: data.count,
          resources: topicResources.slice(0, 3),
        });
      }
    } else {
      // Fallback: no DB available, return empty resources
      for (const [topic, data] of sortedTopics) {
        recommendations.push({
          topic,
          count: data.count,
          resources: [],
        });
      }
    }

    return NextResponse.json({ recommendations });
  } catch (error) {
    logger.error('Error generating study guide', supabaseErrorFields(error));
    return NextResponse.json(
      { error: 'Failed to generate study guide' },
      { status: 500 }
    );
  }
}
