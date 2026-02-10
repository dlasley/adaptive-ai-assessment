'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { verifySession, logoutAdmin } from '@/lib/auth';
import { FEATURES } from '@/lib/feature-flags';
import {
  getClasswideStats,
  getAllStudents,
  searchStudents,
  getStudentProgress,
  exportStudentsToCSV,
  updateAdminLabel,
  updateCountdownOverride,
  deleteStudent,
  deleteStudents,
  type ClasswideStats,
  type StudentSummary,
  type StudentDetailedProgress,
} from '@/lib/admin';
import ConfirmationModal from '@/components/ConfirmationModal';
import StatCard from '@/components/StatCard';
import { getAccuracyColor, getMasteryColor, getMasteryBgColor } from '@/lib/color-utils';
import LoadingSpinner from '@/components/LoadingSpinner';

// Format date and time in PST timezone
function formatDateTimePST(dateString: string): string {
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

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<ClasswideStats | null>(null);
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [filteredStudents, setFilteredStudents] = useState<StudentSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'lastActive' | 'accuracy' | 'quizzes'>('lastActive');
  const [selectedStudent, setSelectedStudent] = useState<StudentDetailedProgress | null>(null);
  const [showStudentDetail, setShowStudentDetail] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelValue, setLabelValue] = useState('');
  const [editingCountdown, setEditingCountdown] = useState(false);
  const [countdownValue, setCountdownValue] = useState('');

  // Selection and deletion state
  const [selectedStudents, setSelectedStudents] = useState<Set<string>>(new Set());
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'single' | 'bulk'; code?: string }>({ type: 'bulk' });

  // Check authentication
  useEffect(() => {
    verifySession().then((valid) => {
      if (!valid) {
        router.push('/admin/login');
      }
    });
  }, [router]);

  // Load data on mount
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [classStats, allStudents] = await Promise.all([
          getClasswideStats(),
          getAllStudents(sortBy),
        ]);

        setStats(classStats);
        setStudents(allStudents);
        setFilteredStudents(allStudents);
      } catch (error) {
        console.error('Error loading admin data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [sortBy]);

  // Handle search
  useEffect(() => {
    const performSearch = async () => {
      if (!searchQuery.trim()) {
        setFilteredStudents(students);
        return;
      }

      const results = await searchStudents(searchQuery);
      setFilteredStudents(results);
    };

    const debounce = setTimeout(performSearch, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery, students]);

  // Handle student selection
  const handleStudentClick = async (code: string) => {
    try {
      const progress = await getStudentProgress(code);
      if (progress) {
        setSelectedStudent(progress);
        setShowStudentDetail(true);
        setLabelValue(progress.studyCode.adminLabel || '');
        setEditingLabel(false);
      }
    } catch (error) {
      console.error('Error loading student details:', error);
    }
  };

  // Handle admin label update
  const handleUpdateLabel = async () => {
    if (!selectedStudent) return;

    try {
      const success = await updateAdminLabel(selectedStudent.studyCode.code, labelValue);
      if (success) {
        // Update local state
        setSelectedStudent({
          ...selectedStudent,
          studyCode: {
            ...selectedStudent.studyCode,
            adminLabel: labelValue,
          },
        });
        setEditingLabel(false);
        // Refresh students list
        const updatedStudents = await getAllStudents(sortBy);
        setStudents(updatedStudents);
        setFilteredStudents(searchQuery ? await searchStudents(searchQuery) : updatedStudents);
      }
    } catch (error) {
      console.error('Error updating admin label:', error);
    }
  };

  // Handle countdown override update
  const handleUpdateCountdown = async (value: number | null) => {
    if (!selectedStudent) return;

    try {
      const success = await updateCountdownOverride(selectedStudent.studyCode.code, value);
      if (success) {
        setSelectedStudent({
          ...selectedStudent,
          studyCode: {
            ...selectedStudent.studyCode,
            wrongAnswerCountdown: value,
          },
        });
        setEditingCountdown(false);
        const updatedStudents = await getAllStudents(sortBy);
        setStudents(updatedStudents);
        setFilteredStudents(searchQuery ? await searchStudents(searchQuery) : updatedStudents);
      }
    } catch (error) {
      console.error('Error updating countdown override:', error);
    }
  };

  // Handle export
  const handleExport = () => {
    const csv = exportStudentsToCSV(filteredStudents);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `student-progress-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Handle selection
  const handleSelectStudent = (code: string) => {
    setSelectedStudents((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedStudents.size === filteredStudents.length) {
      setSelectedStudents(new Set());
    } else {
      setSelectedStudents(new Set(filteredStudents.map((s) => s.code)));
    }
  };

  // Handle deletion
  const handleDeleteSelected = () => {
    setDeleteTarget({ type: 'bulk' });
    setShowDeleteModal(true);
  };

  const handleDeleteSingleStudent = (code: string) => {
    setDeleteTarget({ type: 'single', code });
    setShowDeleteModal(true);
  };

  const confirmDelete = async () => {
    setIsDeleting(true);
    try {
      if (deleteTarget.type === 'single' && deleteTarget.code) {
        const success = await deleteStudent(deleteTarget.code);
        if (success) {
          // If we're viewing this student's detail, go back to list
          if (showStudentDetail && selectedStudent?.studyCode.code === deleteTarget.code) {
            setShowStudentDetail(false);
            setSelectedStudent(null);
          }
          // Remove from selection if selected
          setSelectedStudents((prev) => {
            const next = new Set(prev);
            next.delete(deleteTarget.code!);
            return next;
          });
        }
      } else {
        await deleteStudents(Array.from(selectedStudents));
        setSelectedStudents(new Set());
      }

      // Refresh the student list
      const updatedStudents = await getAllStudents(sortBy);
      setStudents(updatedStudents);
      setFilteredStudents(searchQuery ? await searchStudents(searchQuery) : updatedStudents);

      // Refresh stats
      const updatedStats = await getClasswideStats();
      setStats(updatedStats);
    } catch (error) {
      console.error('Error during deletion:', error);
    } finally {
      setIsDeleting(false);
      setShowDeleteModal(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <LoadingSpinner className="mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-300">Loading admin dashboard...</p>
        </div>
      </div>
    );
  }

  // Student detail modal
  if (showStudentDetail && selectedStudent) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Back Button */}
        <button
          onClick={() => setShowStudentDetail(false)}
          className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
        >
          ← Back to All Students
        </button>

        {/* Student Header */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
                {selectedStudent.studyCode.displayName || 'Anonymous Student'}
              </h1>
              <code className="text-lg font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-gray-900 px-3 py-1 rounded">
                {selectedStudent.studyCode.code}
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
                      placeholder="e.g., Student name, seat number, etc."
                      className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white"
                    />
                    <button
                      onClick={handleUpdateLabel}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingLabel(false);
                        setLabelValue(selectedStudent.studyCode.adminLabel || '');
                      }}
                      className="px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-900 dark:text-white rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-900 dark:text-white font-medium">
                      {selectedStudent.studyCode.adminLabel || <span className="text-gray-400 italic">Not set</span>}
                    </span>
                    <button
                      onClick={() => setEditingLabel(true)}
                      className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      {selectedStudent.studyCode.adminLabel ? 'Edit' : 'Add'}
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
                      className="w-24 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white"
                    />
                    <span className="text-sm text-gray-500 dark:text-gray-400">seconds</span>
                    <button
                      onClick={() => {
                        const parsed = parseInt(countdownValue, 10);
                        if (!isNaN(parsed) && parsed >= 0) {
                          handleUpdateCountdown(parsed);
                        }
                      }}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => handleUpdateCountdown(null)}
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
                      {selectedStudent.studyCode.wrongAnswerCountdown !== null
                        ? `${selectedStudent.studyCode.wrongAnswerCountdown}s`
                        : <span className="text-gray-400 italic">Default ({FEATURES.WRONG_ANSWER_COUNTDOWN_SECONDS}s)</span>
                      }
                    </span>
                    <button
                      onClick={() => {
                        setCountdownValue(
                          selectedStudent.studyCode.wrongAnswerCountdown !== null
                            ? String(selectedStudent.studyCode.wrongAnswerCountdown)
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
                {formatDateTimePST(selectedStudent.studyCode.lastActive)}
              </div>
              <button
                onClick={() => handleDeleteSingleStudent(selectedStudent.studyCode.code)}
                className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
              >
                Delete Student
              </button>
            </div>
          </div>
        </div>

        {/* Student Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard value={selectedStudent.studyCode.totalQuizzes} label="Quizzes" colorClass="text-indigo-600 dark:text-indigo-400" />
          <StatCard value={selectedStudent.studyCode.totalQuestions} label="Questions" colorClass="text-purple-600 dark:text-purple-400" />
          <StatCard value={selectedStudent.studyCode.correctAnswers} label="Correct" colorClass="text-green-600 dark:text-green-400" />
          <StatCard value={`${selectedStudent.studyCode.overallAccuracy.toFixed(0)}%`} label="Accuracy" colorClass={getAccuracyColor(selectedStudent.studyCode.overallAccuracy)} />
        </div>

        {/* Quiz History */}
        {selectedStudent.quizHistory.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
              Quiz History
            </h2>
            <div className="space-y-3">
              {selectedStudent.quizHistory.map((quiz) => (
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
        {selectedStudent.conceptMastery.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
              Topic Mastery
            </h2>
            <div className="space-y-3">
              {selectedStudent.conceptMastery.map((concept) => (
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
        {selectedStudent.weakTopics.length > 0 && (
          <div className="bg-orange-50 dark:bg-orange-900/20 border-2 border-orange-200 dark:border-orange-800 rounded-xl shadow-lg p-6">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
              Topics Needing Practice
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              Below 70% accuracy
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {selectedStudent.weakTopics.map((topic) => (
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
        <ConfirmationModal
          isOpen={showDeleteModal}
          onClose={() => setShowDeleteModal(false)}
          onConfirm={confirmDelete}
          title="Delete Student?"
          message="This will permanently delete this student and all their quiz history. This action cannot be undone."
          confirmText="Delete"
          variant="danger"
          isLoading={isDeleting}
        />
      </div>
    );
  }

  // Main admin dashboard
  return (
    <div className="max-w-7xl mx-auto space-y-8">
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
          onClick={async () => {
            await logoutAdmin();
            router.push('/admin/login');
          }}
          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium flex items-center gap-2"
        >
          🔓 Logout
        </button>
      </div>

      {/* Class-wide Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard value={stats.totalStudents} label="Total Students" colorClass="text-indigo-600 dark:text-indigo-400" />
          <StatCard value={stats.totalQuizzes} label="Total Quizzes" colorClass="text-purple-600 dark:text-purple-400" />
          <StatCard value={stats.totalQuestions} label="Questions Answered" colorClass="text-blue-600 dark:text-blue-400" />
          <StatCard value={`${stats.averageAccuracy.toFixed(0)}%`} label="Class Average" colorClass={getAccuracyColor(stats.averageAccuracy)} />
          <StatCard value={stats.activeStudentsLast7Days} label="Active (7 days)" colorClass="text-green-600 dark:text-green-400" />
          <StatCard value={stats.activeStudentsLast30Days} label="Active (30 days)" colorClass="text-teal-600 dark:text-teal-400" />
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
              className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white"
            />
          </div>

          {/* Sort */}
          <div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'lastActive' | 'accuracy' | 'quizzes')}
              className="px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-lg focus:border-indigo-500 focus:outline-none dark:bg-gray-700 dark:text-white"
            >
              <option value="lastActive">Sort by Last Active</option>
              <option value="accuracy">Sort by Accuracy</option>
              <option value="quizzes">Sort by Quiz Count</option>
            </select>
          </div>

          {/* Export */}
          <button
            onClick={handleExport}
            disabled={filteredStudents.length === 0}
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
                    checked={filteredStudents.length > 0 && selectedStudents.size === filteredStudents.length}
                    onChange={handleSelectAll}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
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
              {filteredStudents.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center text-gray-500 dark:text-gray-400">
                    {searchQuery ? 'No students found matching your search' : 'No students yet'}
                  </td>
                </tr>
              ) : (
                filteredStudents.map((student) => (
                  <tr
                    key={student.code}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                      selectedStudents.has(student.code) ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''
                    }`}
                  >
                    <td className="px-4 py-4 text-center">
                      <input
                        type="checkbox"
                        checked={selectedStudents.has(student.code)}
                        onChange={() => handleSelectStudent(student.code)}
                        className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-sm font-mono text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-gray-900 px-2 py-1 rounded">
                        {student.code}
                      </code>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                      {student.displayName || <span className="text-gray-400 italic">Anonymous</span>}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                      {student.adminLabel || <span className="text-gray-400 italic">-</span>}
                    </td>
                    <td className="px-6 py-4 text-center text-sm font-semibold text-gray-900 dark:text-white">
                      {student.totalQuizzes}
                    </td>
                    <td className="px-6 py-4 text-center text-sm font-semibold text-gray-900 dark:text-white">
                      {student.totalQuestions}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`text-sm font-bold ${
                        student.totalQuestions > 0 ? getAccuracyColor(student.overallAccuracy) :
                        'text-gray-400 dark:text-gray-500'
                      }`}>
                        {student.totalQuestions > 0 ? `${student.overallAccuracy.toFixed(0)}%` : '-'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
                      {formatDateTimePST(student.lastActive)}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button
                        onClick={() => handleStudentClick(student.code)}
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
          onClick={() => router.push('/')}
          className="px-6 py-3 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors font-medium"
        >
          ← Back to Home
        </button>
      </div>

      {/* Bulk Action Bar */}
      {selectedStudents.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t-2 border-gray-200 dark:border-gray-700 shadow-lg p-4 z-40">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {selectedStudents.size} student{selectedStudents.size !== 1 ? 's' : ''} selected
            </span>
            <div className="flex gap-3">
              <button
                onClick={() => setSelectedStudents(new Set())}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                Clear Selection
              </button>
              <button
                onClick={handleDeleteSelected}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
              >
                Delete Selected
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={confirmDelete}
        title={deleteTarget.type === 'single' ? 'Delete Student?' : `Delete ${selectedStudents.size} Student${selectedStudents.size !== 1 ? 's' : ''}?`}
        message={
          deleteTarget.type === 'single'
            ? 'This will permanently delete this student and all their quiz history. This action cannot be undone.'
            : `This will permanently delete ${selectedStudents.size} student${selectedStudents.size !== 1 ? 's' : ''} and all their quiz history. This action cannot be undone.`
        }
        confirmText="Delete"
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  );
}
