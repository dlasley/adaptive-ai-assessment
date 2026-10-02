import { NextRequest, NextResponse } from 'next/server';
import { supabase, isSupabaseAvailable } from '@/lib/supabase';
import { studyGuideSchema } from '@/lib/api-schemas';
import { verifyCsrfProtection } from '@/lib/csrf';
import { checkRateLimit, getClientIp } from '@/lib/rate-limiter';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('study-guide');

// Rate limit: 30 requests per minute per IP
const STUDY_GUIDE_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30 };

interface TopicRecommendation {
  topic: string;
  count: number;
  resources: { url: string; title: string }[];
}

export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const rateLimitResult = await checkRateLimit(`study-guide:${getClientIp(request)}`, STUDY_GUIDE_RATE_LIMIT);
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait before trying again.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)) },
      },
    );
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // The list is derived from one quiz's questions, so the schema bounds it to the per-quiz cap.
    const parsed = studyGuideSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { incorrectQuestions } = parsed.data;

    if (incorrectQuestions.length === 0) {
      return NextResponse.json({ recommendations: [] });
    }

    // Group incorrect questions by topic. A Map keeps a topic named "__proto__" an ordinary key.
    const topicCounts = new Map<string, { count: number; unitId: string }>();

    for (const q of incorrectQuestions) {
      const entry = topicCounts.get(q.topic) ?? { count: 0, unitId: q.unitId };
      entry.count++;
      topicCounts.set(q.topic, entry);
    }

    // Sort topics by number of incorrect answers (descending)
    const sortedTopics = [...topicCounts.entries()]
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
