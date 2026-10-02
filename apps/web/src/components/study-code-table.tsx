import type { ClasswideStats, StudyCodeSummary } from '@/lib/admin-client';
import type { ActionFeedback, DeleteTarget, SortBy } from '@/hooks/use-admin-study-codes';
import StatCard from '@/components/stat-card';
import { getAccuracyColor } from '@/lib/color-utils';
import LiveRegion from '@/components/live-region';
import { ActionFeedbackToast } from '@/components/action-feedback-toast';
import { DeleteConfirmModal } from '@/components/delete-confirm-modal';
import { formatDateTimePST } from '@/lib/format-date';

export interface StudyCodeTableProps {
  stats: ClasswideStats | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  sortBy: SortBy;
  setSortBy: (sort: SortBy) => void;
  onExport: () => void;
  filteredStudyCodes: StudyCodeSummary[];
  selectedStudyCodes: Set<string>;
  onSelectStudyCode: (code: string) => void;
  onSelectAll: () => void;
  onStudyCodeClick: (code: string) => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  onLogout: () => void;
  onBackHome: () => void;
  actionFeedback: ActionFeedback | null;
  showDeleteModal: boolean;
  onCloseDeleteModal: () => void;
  onConfirmDelete: () => void;
  isDeleting: boolean;
  deleteTarget: DeleteTarget;
}

/** The main teacher dashboard: class-wide stats, search/sort/export controls, the student list
 * table, and the bulk-selection action bar. */
export function StudyCodeTable({
  stats,
  searchQuery,
  setSearchQuery,
  sortBy,
  setSortBy,
  onExport,
  filteredStudyCodes,
  selectedStudyCodes,
  onSelectStudyCode,
  onSelectAll,
  onStudyCodeClick,
  onClearSelection,
  onDeleteSelected,
  onLogout,
  onBackHome,
  actionFeedback,
  showDeleteModal,
  onCloseDeleteModal,
  onConfirmDelete,
  isDeleting,
  deleteTarget,
}: StudyCodeTableProps) {
  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <LiveRegion message={actionFeedback?.message ?? ''} />
      <ActionFeedbackToast feedback={actionFeedback} />
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex-1 text-center">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-3">
            Teacher Dashboard
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            Monitor student progress and class performance
          </p>
        </div>
        <button
          onClick={onLogout}
          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium flex items-center gap-2"
        >
          🔓 Logout
        </button>
      </div>

      {/* Class-wide Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-4">
          <StatCard value={stats.totalStudyCodes} label="Total Students" colorClass="text-indigo-600 dark:text-indigo-400" />
          <StatCard value={stats.totalQuizzes} label="Total Quizzes" colorClass="text-purple-600 dark:text-purple-400" />
          <StatCard value={stats.totalQuestions} label="Questions Answered" colorClass="text-blue-600 dark:text-blue-400" />
          <StatCard value={`${stats.averageAccuracy.toFixed(0)}%`} label="Class Average" colorClass={getAccuracyColor(stats.averageAccuracy)} />
          <StatCard value={stats.activeStudyCodesLast7Days} label="Active (7 days)" colorClass="text-green-600 dark:text-green-400" />
          <StatCard value={stats.activeStudyCodesLast30Days} label="Active (30 days)" colorClass="text-teal-600 dark:text-teal-400" />
          <StatCard value={stats.inactiveStudyCodes} label="Inactive (90+ days)" colorClass="text-gray-600 dark:text-gray-400" />
        </div>
      )}

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
        <div className="flex flex-col md:flex-row gap-4">
          {/* Search */}
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search by study code, display name, or admin label..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-gray-700 dark:text-white"
            />
          </div>

          {/* Sort */}
          <div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-gray-700 dark:text-white"
            >
              <option value="lastActive">Sort by Last Active</option>
              <option value="accuracy">Sort by Accuracy</option>
              <option value="quizzes">Sort by Quiz Count</option>
            </select>
          </div>

          {/* Export */}
          <button
            onClick={onExport}
            disabled={filteredStudyCodes.length === 0}
            className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Student List */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-900 border-b-2 border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-4 py-4 text-center">
                  <input
                    type="checkbox"
                    checked={filteredStudyCodes.length > 0 && selectedStudyCodes.size === filteredStudyCodes.length}
                    onChange={onSelectAll}
                    className="h-4 w-4 rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                </th>
                <th className="px-6 py-4 text-left text-sm font-bold text-gray-700 dark:text-gray-300">
                  Study Code
                </th>
                <th className="px-6 py-4 text-left text-sm font-bold text-gray-700 dark:text-gray-300">
                  Display Name
                </th>
                <th className="px-6 py-4 text-left text-sm font-bold text-gray-700 dark:text-gray-300">
                  Admin Label
                </th>
                <th className="px-6 py-4 text-center text-sm font-bold text-gray-700 dark:text-gray-300">
                  Quizzes
                </th>
                <th className="px-6 py-4 text-center text-sm font-bold text-gray-700 dark:text-gray-300">
                  Questions
                </th>
                <th className="px-6 py-4 text-center text-sm font-bold text-gray-700 dark:text-gray-300">
                  Accuracy
                </th>
                <th className="px-6 py-4 text-left text-sm font-bold text-gray-700 dark:text-gray-300">
                  Last Active (PST)
                </th>
                <th className="px-6 py-4 text-center text-sm font-bold text-gray-700 dark:text-gray-300">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {filteredStudyCodes.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center text-gray-500 dark:text-gray-400">
                    {searchQuery ? 'No students found matching your search' : 'No students yet'}
                  </td>
                </tr>
              ) : (
                filteredStudyCodes.map((studyCode) => (
                  <tr
                    key={studyCode.code}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                      selectedStudyCodes.has(studyCode.code) ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''
                    }`}
                  >
                    <td className="px-4 py-4 text-center">
                      <input
                        type="checkbox"
                        checked={selectedStudyCodes.has(studyCode.code)}
                        onChange={() => onSelectStudyCode(studyCode.code)}
                        className="h-4 w-4 rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-sm font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-gray-900 px-2 py-1 rounded-sm">
                        {studyCode.code}
                      </code>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                      {studyCode.displayName || <span className="text-gray-500 dark:text-gray-400 italic">Anonymous</span>}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                      {studyCode.adminLabel || <span className="text-gray-500 dark:text-gray-400 italic">-</span>}
                    </td>
                    <td className="px-6 py-4 text-center text-sm font-semibold text-gray-900 dark:text-white">
                      {studyCode.totalQuizzes}
                    </td>
                    <td className="px-6 py-4 text-center text-sm font-semibold text-gray-900 dark:text-white">
                      {studyCode.totalQuestions}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`text-sm font-bold ${
                        studyCode.totalQuestions > 0 ? getAccuracyColor(studyCode.overallAccuracy) :
                        'text-gray-500 dark:text-gray-400'
                      }`}>
                        {studyCode.totalQuestions > 0 ? `${studyCode.overallAccuracy.toFixed(0)}%` : '-'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
                      {formatDateTimePST(studyCode.lastActive)}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button
                        onClick={() => onStudyCodeClick(studyCode.code)}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium text-sm"
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Back Button */}
      <div className="text-center">
        <button
          onClick={onBackHome}
          className="px-6 py-3 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors font-medium"
        >
          ← Back to Home
        </button>
      </div>

      {/* Bulk Action Bar */}
      {selectedStudyCodes.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t-2 border-gray-200 dark:border-gray-700 shadow-lg p-4 z-40">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {selectedStudyCodes.size} student{selectedStudyCodes.size !== 1 ? 's' : ''} selected
            </span>
            <div className="flex gap-3">
              <button
                onClick={onClearSelection}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                Clear Selection
              </button>
              <button
                onClick={onDeleteSelected}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
              >
                Delete Selected
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={showDeleteModal}
        onClose={onCloseDeleteModal}
        onConfirm={onConfirmDelete}
        isLoading={isDeleting}
        deleteTarget={deleteTarget}
        selectedCount={selectedStudyCodes.size}
      />
    </div>
  );
}
