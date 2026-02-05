/**
 * Topic-to-heading mappings for content extraction
 *
 * This file maps topic names (from units.ts) to the markdown headings
 * where their content can be found. Generated/updated by suggest-unit-topics.ts.
 *
 * Format: { "Topic Name": ["heading pattern 1", "heading pattern 2", ...] }
 * Patterns are case-insensitive substrings to match in markdown headings.
 */

export const topicHeadings: Record<string, string[]> = {
  // Introduction unit
  'Greetings (Formal & Informal)': ['salutations', 'greetings', 'bonjour', 'formal', 'informal'],
  'Subject Pronouns (je, tu, il/elle...)': ['pronouns', 'pronoms', 'je, tu', 'subject'],
  'Verb: Être (to be)': ['être', 'etre', 'to be'],
  'Numbers 0-20': ['nombres', 'numbers', '0-20', 'chiffres'],
  'Days of the Week & Months': ['jours', 'days', 'mois', 'months', 'semaine'],
  'Weather Expressions': ['météo', 'meteo', 'weather', 'temps', 'il fait'],
  'French Alphabet & Pronunciation': ['alphabet', 'pronunciation', 'prononciation'],
  'Colors (rouge, bleu, vert...)': ['couleurs', 'colors', 'rouge', 'bleu'],
  'Asking Questions (Comment, Pourquoi...)': ['questions', 'comment', 'pourquoi', 'interrogative'],

  // Unit 2
  'Activity Vocabulary (-ER verbs)': ['activités', 'activities', '-er verbs', 'hobbies'],
  '-ER Verb Conjugation': ['conjugaison', 'conjugation', '-er verb', 'parler'],
  'Expressing Likes/Dislikes (aimer, préférer)': ['aimer', 'préférer', 'preferer', 'likes', 'dislikes', 'adorer'],
  'Definite Articles (le, la, les)': ['articles définis', 'definite articles', 'le, la, les'],
  'Common -ER Verbs': ['-er verbs', 'verbes en -er', 'parler', 'manger', 'jouer'],
  'Negation (ne...pas)': ['négation', 'negation', 'ne...pas', 'ne pas'],
  'Nationalities': ['nationalités', 'nationalities', 'pays', 'countries'],
  'Classroom Expressions': ['expressions', 'classroom', 'salle de classe'],

  // Unit 3
  'Classroom Vocabulary (objects)': ['salle de classe', 'classroom', 'objets', 'vocabulaire actif'],
  'Numbers 20-100': ['nombres', 'numbers', '20-100', 'vingt'],
  'Prepositions (sous, sur, derrière)': ['prépositions', 'prepositions', 'sous', 'sur', 'derrière'],
  'Face & Body Parts Vocabulary': ['visage', 'corps', 'body', 'face', 'parties du corps'],
  'Indefinite Articles (un, une, des)': ['articles indéfinis', 'indefinite articles', 'un, une, des'],
  'Verb: Avoir (to have)': ['avoir', 'to have'],
  'Expressions with Avoir': ['avoir', 'expressions', 'j\'ai faim', 'j\'ai soif', 'j\'ai besoin'],
  'School Subjects': ['matières', 'subjects', 'school subjects', 'scolaires'],
  'Telling Time (Quelle heure est-il?)': ['heure', 'time', 'quelle heure', 'telling time'],
  'Christmas Vocabulary': ['noël', 'noel', 'christmas', 'fête'],
  'Questions with est-ce que': ['est-ce que', 'questions', 'interrogative'],
  'Combining Sentences (qui, quand, où)': ['qui', 'quand', 'où', 'combining', 'relative'],
  'Location Vocabulary (en ville, à la cantine, etc.)': ['ville', 'location', 'où', 'cantine', 'endroits'],
};

/**
 * Get heading patterns for a topic
 * Returns empty array if no mapping exists (will trigger warning during extraction)
 */
export function getTopicHeadings(topic: string): string[] {
  return topicHeadings[topic] || [];
}

/**
 * Add or update topic heading mapping
 * Call this from suggest-unit-topics.ts when extracting topics
 */
export function addTopicHeading(topic: string, headings: string[]): void {
  topicHeadings[topic] = headings;
}
