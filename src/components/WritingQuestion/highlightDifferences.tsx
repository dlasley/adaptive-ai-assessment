/**
 * Utility to highlight differences between user answer and corrected answer
 * Returns JSX with differences highlighted
 */

export function highlightDifferences(userAnswer: string, correctedAnswer: string): JSX.Element {
  const userWords = userAnswer.split(/(\s+)/);
  const correctedWords = correctedAnswer.split(/(\s+)/);
  const maxLength = Math.max(userWords.length, correctedWords.length);

  const elements: JSX.Element[] = [];

  for (let i = 0; i < maxLength; i++) {
    const userWord = userWords[i] || '';
    const correctedWord = correctedWords[i] || '';

    // Preserve whitespace as-is
    if (/^\s+$/.test(correctedWord)) {
      elements.push(<span key={i}>{correctedWord}</span>);
      continue;
    }

    if (userWord !== correctedWord) {
      // Highlight the corrected word
      elements.push(
        <span key={i} className="bg-green-200 dark:bg-green-700 font-semibold px-1 rounded">
          {correctedWord}
        </span>
      );
    } else {
      elements.push(<span key={i}>{correctedWord}</span>);
    }
  }

  return <>{elements}</>;
}
