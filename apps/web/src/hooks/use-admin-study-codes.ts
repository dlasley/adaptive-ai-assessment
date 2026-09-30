import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { verifySession, logoutAdmin } from '@/lib/auth';
import {
  getClasswideStats,
  getAllStudyCodes,
  searchStudyCodes,
  getStudyCodeProgress,
  exportStudyCodesToCSV,
  updateAdminLabel,
  updateCountdownOverride,
  deleteStudyCode,
  deleteStudyCodes,
  type ClasswideStats,
  type StudyCodeSummary,
  type StudyCodeDetailedProgress,
} from '@/lib/admin-client';

export type ActionFeedback = { type: 'success' | 'error'; message: string };
export type DeleteTarget = { type: 'single' | 'bulk'; code?: string };
export type SortBy = 'lastActive' | 'accuracy' | 'quizzes';

/**
 * Auth check, data loading, search, and every label/countdown/selection/delete handler for the
 * admin dashboard. Carries no JSX — the page and its presentational components render from what
 * this returns.
 */
export function useAdminStudyCodes() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<ClasswideStats | null>(null);
  const [studyCodes, setStudyCodes] = useState<StudyCodeSummary[]>([]);
  const [filteredStudyCodes, setFilteredStudyCodes] = useState<StudyCodeSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('lastActive');
  const [selectedStudyCodeDetail, setSelectedStudyCodeDetail] = useState<StudyCodeDetailedProgress | null>(null);
  const [showStudyCodeDetail, setShowStudyCodeDetail] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelValue, setLabelValue] = useState('');
  const [editingCountdown, setEditingCountdown] = useState(false);
  const [countdownValue, setCountdownValue] = useState('');

  // Selection and deletion state
  const [selectedStudyCodes, setSelectedStudyCodes] = useState<Set<string>>(new Set());
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>({ type: 'bulk' });

  // Visible + screen-reader feedback for admin writes (label/countdown edits, deletes) — without
  // it, success and failure are indistinguishable from the UI alone.
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announceAction = (type: ActionFeedback['type'], message: string) => {
    setActionFeedback({ type, message });
    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    feedbackTimeoutRef.current = setTimeout(() => setActionFeedback(null), 4000);
  };

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    };
  }, []);

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
        const [classStats, allStudyCodes] = await Promise.all([
          getClasswideStats(),
          getAllStudyCodes(sortBy),
        ]);

        setStats(classStats);
        setStudyCodes(allStudyCodes);
        setFilteredStudyCodes(allStudyCodes);
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
        setFilteredStudyCodes(studyCodes);
        return;
      }

      const results = await searchStudyCodes(searchQuery);
      setFilteredStudyCodes(results);
    };

    const debounce = setTimeout(performSearch, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery, studyCodes]);

  // Handle study code selection
  const handleStudyCodeClick = async (code: string) => {
    try {
      const progress = await getStudyCodeProgress(code);
      if (progress) {
        setSelectedStudyCodeDetail(progress);
        setShowStudyCodeDetail(true);
        setLabelValue(progress.studyCode.adminLabel || '');
        setEditingLabel(false);
      }
    } catch (error) {
      console.error('Error loading study code details:', error);
    }
  };

  // Handle admin label update
  const handleUpdateLabel = async () => {
    if (!selectedStudyCodeDetail) return;

    try {
      const success = await updateAdminLabel(selectedStudyCodeDetail.studyCode.code, labelValue);
      if (success) {
        // Update local state
        setSelectedStudyCodeDetail({
          ...selectedStudyCodeDetail,
          studyCode: {
            ...selectedStudyCodeDetail.studyCode,
            adminLabel: labelValue,
          },
        });
        setEditingLabel(false);
        // Refresh study codes list
        const updatedStudyCodes = await getAllStudyCodes(sortBy);
        setStudyCodes(updatedStudyCodes);
        setFilteredStudyCodes(searchQuery ? await searchStudyCodes(searchQuery) : updatedStudyCodes);
        announceAction('success', 'Label saved.');
      } else {
        announceAction('error', 'Failed to save label. Please try again.');
      }
    } catch (error) {
      console.error('Error updating admin label:', error);
      announceAction('error', 'Failed to save label. Please try again.');
    }
  };

  // Handle countdown override update
  const handleUpdateCountdown = async (value: number | null) => {
    if (!selectedStudyCodeDetail) return;

    try {
      const success = await updateCountdownOverride(selectedStudyCodeDetail.studyCode.code, value);
      if (success) {
        setSelectedStudyCodeDetail({
          ...selectedStudyCodeDetail,
          studyCode: {
            ...selectedStudyCodeDetail.studyCode,
            wrongAnswerCountdown: value,
          },
        });
        setEditingCountdown(false);
        const updatedStudyCodes = await getAllStudyCodes(sortBy);
        setStudyCodes(updatedStudyCodes);
        setFilteredStudyCodes(searchQuery ? await searchStudyCodes(searchQuery) : updatedStudyCodes);
        announceAction('success', 'Countdown override saved.');
      } else {
        announceAction('error', 'Failed to save countdown override. Please try again.');
      }
    } catch (error) {
      console.error('Error updating countdown override:', error);
      announceAction('error', 'Failed to save countdown override. Please try again.');
    }
  };

  // Handle export
  const handleExport = () => {
    const csv = exportStudyCodesToCSV(filteredStudyCodes);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `student-progress-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Handle selection
  const handleSelectStudyCode = (code: string) => {
    setSelectedStudyCodes((prev) => {
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
    if (selectedStudyCodes.size === filteredStudyCodes.length) {
      setSelectedStudyCodes(new Set());
    } else {
      setSelectedStudyCodes(new Set(filteredStudyCodes.map((s) => s.code)));
    }
  };

  // Handle deletion
  const handleDeleteSelected = () => {
    setDeleteTarget({ type: 'bulk' });
    setShowDeleteModal(true);
  };

  const handleDeleteSingleStudyCode = (code: string) => {
    setDeleteTarget({ type: 'single', code });
    setShowDeleteModal(true);
  };

  const confirmDelete = async () => {
    setIsDeleting(true);
    try {
      if (deleteTarget.type === 'single' && deleteTarget.code) {
        const success = await deleteStudyCode(deleteTarget.code);
        if (!success) {
          announceAction('error', 'Failed to delete student. Please try again.');
          return;
        }
        // If we're viewing this study code's detail, go back to list
        if (showStudyCodeDetail && selectedStudyCodeDetail?.studyCode.code === deleteTarget.code) {
          setShowStudyCodeDetail(false);
          setSelectedStudyCodeDetail(null);
        }
        // Remove from selection if selected
        setSelectedStudyCodes((prev) => {
          const next = new Set(prev);
          next.delete(deleteTarget.code!);
          return next;
        });
        announceAction('success', 'Student deleted.');
      } else {
        const result = await deleteStudyCodes(Array.from(selectedStudyCodes));
        const plural = (n: number) => `${n} student${n !== 1 ? 's' : ''}`;
        // Failed codes stay selected so the teacher can retry them.
        setSelectedStudyCodes(new Set(result.failed));
        if (result.failed.length === 0 && result.success) {
          announceAction('success', `${plural(result.deleted)} deleted.`);
        } else if (result.deleted > 0) {
          announceAction(
            'error',
            `${plural(result.deleted)} deleted, but ${plural(result.failed.length)} could not be deleted. They are still selected; please try again.`
          );
        } else {
          announceAction('error', 'Failed to delete the selected students. Please try again.');
        }
      }

      // Refresh the study code list
      const updatedStudyCodes = await getAllStudyCodes(sortBy);
      setStudyCodes(updatedStudyCodes);
      setFilteredStudyCodes(searchQuery ? await searchStudyCodes(searchQuery) : updatedStudyCodes);

      // Refresh stats
      const updatedStats = await getClasswideStats();
      setStats(updatedStats);
    } catch (error) {
      console.error('Error during deletion:', error);
      announceAction('error', 'Failed to delete. Please try again.');
    } finally {
      setIsDeleting(false);
      setShowDeleteModal(false);
    }
  };

  return {
    router,
    loading, stats,
    studyCodes, filteredStudyCodes,
    searchQuery, setSearchQuery,
    sortBy, setSortBy,
    selectedStudyCodeDetail, showStudyCodeDetail, setShowStudyCodeDetail,
    editingLabel, setEditingLabel, labelValue, setLabelValue,
    editingCountdown, setEditingCountdown, countdownValue, setCountdownValue,
    selectedStudyCodes, setSelectedStudyCodes,
    showDeleteModal, setShowDeleteModal, isDeleting, deleteTarget,
    actionFeedback,
    handleStudyCodeClick, handleUpdateLabel, handleUpdateCountdown, handleExport,
    handleSelectStudyCode, handleSelectAll,
    handleDeleteSelected, handleDeleteSingleStudyCode, confirmDelete,
    logoutAdmin,
  };
}
