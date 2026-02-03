/**
 * Video Resources Mapping
 * Maps topics and question types to relevant YouTube videos from learning materials
 */

export interface VideoResource {
  url: string;
  title: string;
  topics: string[];
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  duration?: string;
}

/**
 * Curated video resources from French 1 course materials
 */
export const VIDEO_RESOURCES: VideoResource[] = [
  // Introduction Unit - Basics
  {
    url: 'https://www.youtube.com/watch?v=YkFXGlHCn_o',
    title: 'French Alphabet',
    topics: ['alphabet', 'pronunciation', 'basics', 'greetings'],
    difficulty: 'beginner',
  },
  {
    url: 'https://www.youtube.com/watch?v=XFuaFwGEZ9M',
    title: 'French Culture and Basics',
    topics: ['culture', 'introduction', 'basics'],
    difficulty: 'beginner',
  },
  {
    url: 'https://www.youtube.com/watch?v=2x_3cih_i2A',
    title: 'French Conversation Practice',
    topics: ['conversation', 'greetings', 'daily_routine'],
    difficulty: 'beginner',
  },

  // Unit 2 - Communication & Activities
  {
    url: 'https://www.youtube.com/watch?v=bVDbF_4IxYA',
    title: 'Public Speaking in French',
    topics: ['speaking', 'conversation', 'communication'],
    difficulty: 'intermediate',
  },
  {
    url: 'https://www.youtube.com/watch?v=FRNvpiqseIg',
    title: 'French Speaking Skills',
    topics: ['speaking', 'pronunciation', 'conversation'],
    difficulty: 'intermediate',
  },
  {
    url: 'https://www.youtube.com/watch?v=K6YDsogWDzA',
    title: 'Baccalauréat Explained',
    topics: ['culture', 'education'],
    difficulty: 'intermediate',
  },
  {
    url: 'https://www.youtube.com/shorts/aPce21bv6JQ',
    title: 'Baccalauréat Short',
    topics: ['culture', 'education'],
    difficulty: 'intermediate',
  },
  {
    url: 'https://www.youtube.com/watch?v=Lpwf5N0rfVE',
    title: 'Days of the Week in French',
    topics: ['vocabulary', 'time', 'calendar', 'basics'],
    difficulty: 'beginner',
  },

  // Unit 3 - Classroom & Numbers
  {
    url: 'https://www.youtube.com/watch?v=HueGJDGJZK8',
    title: "Qu'est-ce que c'est? (What is it?)",
    topics: ['questions', 'vocabulary', 'classroom'],
    difficulty: 'beginner',
  },
  {
    url: 'https://www.youtube.com/watch?v=wlYqz2unHKc',
    title: 'French Numbers 70-100',
    topics: ['numbers', 'counting', 'vocabulary'],
    difficulty: 'intermediate',
  },
  {
    url: 'https://www.youtube.com/shorts/OIQJjl04mi8',
    title: 'Points de départ',
    topics: ['basics', 'getting_started'],
    difficulty: 'beginner',
  },
  {
    url: 'https://www.youtube.com/shorts/uPt52E1MYk',
    title: "L'euro (European Currency)",
    topics: ['culture', 'money', 'vocabulary'],
    difficulty: 'beginner',
  },
];

/**
 * Get relevant videos for a specific topic
 */
export function getVideosForTopic(topic: string): VideoResource[] {
  const normalizedTopic = topic.toLowerCase().replace(/_/g, ' ');

  return VIDEO_RESOURCES.filter(video =>
    video.topics.some(videoTopic =>
      videoTopic.includes(normalizedTopic) ||
      normalizedTopic.includes(videoTopic)
    )
  );
}

/**
 * Get videos for multiple topics, deduplicated
 */
export function getVideosForTopics(topics: string[]): VideoResource[] {
  const videoSet = new Set<string>();
  const videos: VideoResource[] = [];

  topics.forEach(topic => {
    const topicVideos = getVideosForTopic(topic);
    topicVideos.forEach(video => {
      if (!videoSet.has(video.url)) {
        videoSet.add(video.url);
        videos.push(video);
      }
    });
  });

  return videos;
}

/**
 * Get videos filtered by difficulty level
 */
export function getVideosByDifficulty(
  difficulty: 'beginner' | 'intermediate' | 'advanced'
): VideoResource[] {
  return VIDEO_RESOURCES.filter(
    video => !video.difficulty || video.difficulty === difficulty
  );
}

/**
 * Get recommended videos based on question topics and difficulty
 */
export function getRecommendedVideos(
  topics: string[],
  difficulty?: 'beginner' | 'intermediate' | 'advanced',
  limit = 5
): VideoResource[] {
  let videos = getVideosForTopics(topics);

  // Filter by difficulty if specified
  if (difficulty) {
    videos = videos.filter(
      video => !video.difficulty || video.difficulty === difficulty
    );
  }

  // Return limited number of videos
  return videos.slice(0, limit);
}
