import { FEATURES } from '@/lib/feature-flags';
import type { StudyCodeDetailedProgress } from '@/lib/admin-client';
import type { ActionFeedback, DeleteTarget } from '@/hooks/use-admin-study-codes';
import StatCard from '@/components/stat-card';
import { getAccuracyColor, getMasteryColor, getMasteryBgColor } from '@/lib/color-utils';
import LiveRegion from '@/components/live-region';
import { ActionFeedbackToast } from '@/components/action-feedback-toast';
import { DeleteConfirmModal } from '@/components/delete-confirm-modal';
import { formatDateTimePST } from '@/lib/format-date';

export interface StudyCodeDetailPanelProps {
  detail: StudyCodeDetailedProgress;
  onBack: () => void;
  actionFeedback: ActionFeedback | null;
  editingLabel: boolean;
  setEditingLabel: (editing: boolean) => void;
  labelValue: string;
  setLabelValue: (value: string) => void;
  onUpdateLabel: () => void;
  editingCountdown: boolean;
  setEditingCountdown: (editing: boolean) => void;
  countdownValue: string;
  setCountdownValue: (value: string) => void;
  onUpdateCountdown: (value: number | null) => void;
  onDeleteStudent: (code: string) => void;
  showDeleteModal: boolean;
  onCloseDeleteModal: () => void;
  onConfirmDelete: () => void;
  isDeleting: boolean;
  deleteTarget: DeleteTarget;
}

/** Full-screen detail view for a single student: header (name, code, editable admin label and
 * countdown override), stat cards, quiz history, topic mastery, and weak topics. */
export function StudyCodeDetailPanel({
  detail,
  onBack,
  actionFeedback,
  editingLabel,
  setEditingLabel,
  labelValue,
  setLabelValue,
  onUpdateLabel,
  editingCountdown,
  setEditingCountdown,
  countdownValue,
  setCountdownValue,
  onUpdateCountdown,
  onDeleteStudent,
  showDeleteModal,
  onCloseDeleteModal,
  onConfirmDelete,
  isDeleting,
  deleteTarget,
}: StudyCodeDetailPanelProps) {
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <LiveRegion message={actionFeedback?.message ?? ''} />
      <ActionFeedbackToast feedback={actionFeedback} />
      {/* Back Button */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
      >
        ← Back to All Students
      </button>

      {/* Student Header */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
              {detail.studyCode.displayName || 'Anonymous Student'}
            </h1>
            <code className="text-lg font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-gray-900 px-3 py-1 rounded-sm">
              {detail.studyCode.code}
            </code>

            {/* Admin Label */}
            <div className="mt-4">
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Your Label/Identifier:
              </label>
              {editingLabel ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={labelValue}
                    onChange={(e) => setLabelValue(e.target.value)}
                    placeholder="e.g., Period 3, group A"
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-gray-700 dark:text-white"
                  />
                  <button
                    onClick={onUpdateLabel}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setEditingLabel(false);
                      setLabelValue(detail.studyCode.adminLabel || '');
                    }}
                    className="px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-900 dark:text-white rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors font-medium"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-gray-900 dark:text-white font-medium">
                    {detail.studyCode.adminLabel || <span className="text-gray-500 dark:text-gray-400 italic">Not set</span>}
                  </span>
                  <button
                    onClick={() => setEditingLabel(true)}
                    className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    {detail.studyCode.adminLabel ? 'Edit' : 'Add'}
                  </button>
                </div>
              )}
            </div>

            {/* Wrong Answer Countdown Override */}
            <div className="mt-4">
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Wrong Answer Countdown:
              </label>
              {editingCountdown ? (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    value={countdownValue}
                    onChange={(e) => setCountdownValue(e.target.value)}
                    placeholder="Seconds"
                    className="w-24 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-gray-700 dark:text-white"
                  />
                  <span className="text-sm text-gray-500 dark:text-gray-400">seconds</span>
                  <button
                    onClick={() => {
                      const parsed = parseInt(countdownValue, 10);
                      if (!isNaN(parsed) && parsed >= 0) {
                        onUpdateCountdown(parsed);
                      }
                    }}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => onUpdateCountdown(null)}
                    className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors font-medium"
                  >
                    Reset to Default
                  </button>
                  <button
                    onClick={() => setEditingCountdown(false)}
                    className="px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-900 dark:text-white rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors font-medium"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-gray-900 dark:text-white font-medium">
                    {detail.studyCode.wrongAnswerCountdown !== null
                      ? `${detail.studyCode.wrongAnswerCountdown}s`
                      : <span className="text-gray-500 dark:text-gray-400 italic">Default ({FEATURES.WRONG_ANSWER_COUNTDOWN_SECONDS}s)</span>
                    }
                  </span>
                  <button
                    onClick={() => {
                      setCountdownValue(
                        detail.studyCode.wrongAnswerCountdown !== null
                          ? String(detail.studyCode.wrongAnswerCountdown)
                          : '10'
                      );
                      setEditingCountdown(true);
                    }}
                    className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    Edit
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-600 dark:text-gray-400">Last Active (PST)</div>
            <div className="text-lg font-semibold text-gray-900 dark:text-white">
              {formatDateTimePST(detail.studyCode.lastActive)}
            </div>
            <button
              onClick={() => onDeleteStudent(detail.studyCode.code)}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
            >
              Delete Student
            </button>
          </div>
        </div>
      </div>

      {/* Student Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard value={detail.studyCode.totalQuizzes} label="Quizzes" colorClass="text-indigo-600 dark:text-indigo-400" />
        <StatCard value={detail.studyCode.totalQuestions} label="Questions" colorClass="text-purple-600 dark:text-purple-400" />
        <StatCard value={detail.studyCode.correctAnswers} label="Correct" colorClass="text-green-600 dark:text-green-400" />
        <StatCard value={`${detail.studyCode.overallAccuracy.toFixed(0)}%`} label="Accuracy" colorClass={getAccuracyColor(detail.studyCode.overallAccuracy)} />
      </div>

      {/* Quiz History */}
      {detail.quizHistory.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            Quiz History
          </h2>
          <div className="space-y-3">
            {detail.quizHistory.map((quiz) => (
              <div
                key={quiz.id}
                className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700 rounded-lg"
              >
                <div className="flex-1">
                  <div className="font-semibold text-gray-900 dark:text-white">
                    {quiz.unit_id === 'all' ? 'All Units' : `Unit: ${quiz.unit_id}`}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    {quiz.difficulty.charAt(0).toUpperCase() + quiz.difficulty.slice(1)} • {quiz.total_questions} questions • {formatDateTimePST(quiz.quiz_date)}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-2xl font-bold ${getAccuracyColor(quiz.score_percentage)}`}>
                    {quiz.score_percentage.toFixed(0)}%
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    {quiz.correct_answers}/{quiz.total_questions}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Concept Mastery */}
      {detail.conceptMastery.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            Topic Mastery
          </h2>
          <div className="space-y-3">
            {detail.conceptMastery.map((concept) => (
              <div key={concept.topic} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-gray-900 dark:text-white">
                    {concept.topic}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {concept.correct_attempts}/{concept.total_attempts}
                    </span>
                    <span className={`font-bold ${getMasteryColor(concept.mastery_percentage)}`}>
                      {concept.mastery_percentage.toFixed(0)}%
                    </span>
                  </div>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${getMasteryBgColor(concept.mastery_percentage)}`}
                    style={{ width: `${concept.mastery_percentage}%` }}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Weak Topics */}
      {detail.weakTopics.length > 0 && (
        <div className="bg-orange-50 dark:bg-orange-900/20 border-2 border-orange-200 dark:border-orange-800 rounded-xl shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Topics Needing Practice
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            Below 70% accuracy
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {detail.weakTopics.map((topic) => (
              <div key={topic.topic} className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-orange-200 dark:border-orange-800">
                <div className="font-semibold text-gray-900 dark:text-white mb-1">
                  {topic.topic}
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {topic.mastery_percentage.toFixed(0)}% accuracy • {topic.total_attempts} attempts
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal for Student Detail View */}
      <DeleteConfirmModal
        isOpen={showDeleteModal}
        onClose={onCloseDeleteModal}
        onConfirm={onConfirmDelete}
        isLoading={isDeleting}
        deleteTarget={deleteTarget}
        selectedCount={0}
      />
    </div>
  );
}
