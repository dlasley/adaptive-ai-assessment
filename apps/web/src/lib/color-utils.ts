/**
 * Shared color utilities for accuracy and mastery displays
 */

/**
 * Get text color class for accuracy percentage (80/60 thresholds)
 */
export function getAccuracyColor(percentage: number): string {
  if (percentage >= 80) return 'text-green-600 dark:text-green-400';
  if (percentage >= 60) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

/**
 * Get text color class for mastery percentage (85/70 thresholds)
 */
export function getMasteryColor(percentage: number): string {
  if (percentage >= 85) return 'text-green-600 dark:text-green-400';
  if (percentage >= 70) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

/**
 * Get background color class for mastery percentage (85/70 thresholds)
 */
export function getMasteryBgColor(percentage: number): string {
  if (percentage >= 85) return 'bg-green-600';
  if (percentage >= 70) return 'bg-yellow-600';
  return 'bg-red-600';
}
