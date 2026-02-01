import { NextRequest, NextResponse } from 'next/server';
import { getTopicResources, loadUnitMaterials, extractYouTubeLinks } from '@/lib/learning-materials';

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

    // Get YouTube resources for each topic
    const recommendations: TopicRecommendation[] = [];

    for (const [topic, data] of sortedTopics) {
      try {
        const materials = loadUnitMaterials(data.unitId);
        const resources = extractYouTubeLinks(materials, topic);

        recommendations.push({
          topic,
          count: data.count,
          resources: resources.slice(0, 3), // Limit to 3 videos per topic
        });
      } catch (error) {
        console.error(`Error loading resources for topic ${topic}:`, error);
        recommendations.push({
          topic,
          count: data.count,
          resources: [],
        });
      }
    }

    return NextResponse.json({ recommendations });
  } catch (error) {
    console.error('Error generating study guide:', error);
    return NextResponse.json(
      { error: 'Failed to generate study guide' },
      { status: 500 }
    );
  }
}
