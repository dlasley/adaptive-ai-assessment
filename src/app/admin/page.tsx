'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated, clearAuthSession } from '@/lib/auth';
import {
  getClasswideStats,
  getAllStudents,
  searchStudents,
  getStudentProgress,
  exportStudentsToCSV,
  updateAdminLabel,
  type ClasswideStats,
  type StudentSummary,
  type StudentDetailedProgress,
} from '@/lib/admin';

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

  // Check authentication
  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/admin/login');
      return;
    }
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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
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
            </div>
            <div className="text-right">
              <div className="text-sm text-gray-600 dark:text-gray-400">Last Active (PST)</div>
              <div className="text-lg font-semibold text-gray-900 dark:text-white">
                {formatDateTimePST(selectedStudent.studyCode.lastActive)}
              </div>
            </div>
          </div>
        </div>

        {/* Student Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
            <div className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">
              {selectedStudent.studyCode.totalQuizzes}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-300">Quizzes</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
            <div className="text-3xl font-bold text-purple-600 dark:text-purple-400">
              {selectedStudent.studyCode.totalQuestions}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-300">Questions</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
            <div className="text-3xl font-bold text-green-600 dark:text-green-400">
              {selectedStudent.studyCode.correctAnswers}
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-300">Correct</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
            <div className={`text-3xl font-bold ${
              selectedStudent.studyCode.overallAccuracy >= 80 ? 'text-green-600 dark:text-green-400' :
              selectedStudent.studyCode.overallAccuracy >= 60 ? 'text-yellow-600 dark:text-yellow-400' :
              'text-red-600 dark:text-red-400'
            }`}>
              {selectedStudent.studyCode.overallAccuracy.toFixed(0)}%
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-300">Accuracy</div>
          </div>
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
                    <div className={`text-2xl font-bold ${
                      quiz.score_percentage >= 80 ? 'text-green-600 dark:text-green-400' :
                      quiz.score_percentage >= 60 ? 'text-yellow-600 dark:text-yellow-400' :
                      'text-red-600 dark:text-red-400'
                    }`}>
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
                      <span className={`font-bold ${
                        concept.mastery_percentage >= 85 ? 'text-green-600 dark:text-green-400' :
                        concept.mastery_percentage >= 70 ? 'text-yellow-600 dark:text-yellow-400' :
                        'text-red-600 dark:text-red-400'
                      }`}>
                        {concept.mastery_percentage.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        concept.mastery_percentage >= 85 ? 'bg-green-600' :
                        concept.mastery_percentage >= 70 ? 'bg-yellow-600' :
                        'bg-red-600'
                      }`}
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
          onClick={() => {
            clearAuthSession();
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
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 text-center">
            <div className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">
              {stats.totalStudents}
            </div>
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Total Students
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 text-center">
            <div className="text-3xl font-bold text-purple-600 dark:text-purple-400">
              {stats.totalQuizzes}
            </div>
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Total Quizzes
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 text-center">
            <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
              {stats.totalQuestions}
            </div>
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Questions Answered
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 text-center">
            <div className={`text-3xl font-bold ${
              stats.averageAccuracy >= 80 ? 'text-green-600 dark:text-green-400' :
              stats.averageAccuracy >= 60 ? 'text-yellow-600 dark:text-yellow-400' :
              'text-red-600 dark:text-red-400'
            }`}>
              {stats.averageAccuracy.toFixed(0)}%
            </div>
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Class Average
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 text-center">
            <div className="text-3xl font-bold text-green-600 dark:text-green-400">
              {stats.activeStudentsLast7Days}
            </div>
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Active (7 days)
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 text-center">
            <div className="text-3xl font-bold text-teal-600 dark:text-teal-400">
              {stats.activeStudentsLast30Days}
            </div>
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              Active (30 days)
            </div>
          </div>
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
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-500 dark:text-gray-400">
                    {searchQuery ? 'No students found matching your search' : 'No students yet'}
                  </td>
                </tr>
              ) : (
                filteredStudents.map((student) => (
                  <tr
                    key={student.code}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
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
                        student.overallAccuracy >= 80 ? 'text-green-600 dark:text-green-400' :
                        student.overallAccuracy >= 60 ? 'text-yellow-600 dark:text-yellow-400' :
                        student.overallAccuracy > 0 ? 'text-red-600 dark:text-red-400' :
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
    </div>
  );
}
