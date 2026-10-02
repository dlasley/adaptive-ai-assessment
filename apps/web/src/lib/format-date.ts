/** Date and time in Pacific time, e.g. "Oct 1, 2026, 3:05 PM". */
export function formatDateTimePST(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
