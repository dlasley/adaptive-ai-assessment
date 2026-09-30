export type ActionFeedback = { type: 'success' | 'error'; message: string };

// Visible confirmation for admin writes (label/countdown edits, deletes).
// The matching screen-reader announcement is a separate LiveRegion, since
// this element itself isn't a live region.
export function ActionFeedbackToast({ feedback }: { feedback: ActionFeedback | null }) {
  if (!feedback) return null;
  return (
    <div
      className={`fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-semibold text-white ${
        feedback.type === 'success' ? 'bg-green-600' : 'bg-red-600'
      }`}
    >
      {feedback.message}
    </div>
  );
}
