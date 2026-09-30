'use client';

import LoadingSpinner from '@/components/loading-spinner';
import { StudyCodeTable } from '@/components/study-code-table';
import { StudyCodeDetailPanel } from '@/components/study-code-detail-panel';
import { useAdminStudyCodes } from '@/hooks/use-admin-study-codes';

export default function AdminPage() {
  const {
    router,
    loading, stats,
    filteredStudyCodes,
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
  } = useAdminStudyCodes();

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

  // Student detail view
  if (showStudyCodeDetail && selectedStudyCodeDetail) {
    return (
      <StudyCodeDetailPanel
        detail={selectedStudyCodeDetail}
        onBack={() => setShowStudyCodeDetail(false)}
        actionFeedback={actionFeedback}
        editingLabel={editingLabel}
        setEditingLabel={setEditingLabel}
        labelValue={labelValue}
        setLabelValue={setLabelValue}
        onUpdateLabel={handleUpdateLabel}
        editingCountdown={editingCountdown}
        setEditingCountdown={setEditingCountdown}
        countdownValue={countdownValue}
        setCountdownValue={setCountdownValue}
        onUpdateCountdown={handleUpdateCountdown}
        onDeleteStudent={handleDeleteSingleStudyCode}
        showDeleteModal={showDeleteModal}
        onCloseDeleteModal={() => setShowDeleteModal(false)}
        onConfirmDelete={confirmDelete}
        isDeleting={isDeleting}
        deleteTarget={deleteTarget}
      />
    );
  }

  // Main admin dashboard
  return (
    <StudyCodeTable
      stats={stats}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      sortBy={sortBy}
      setSortBy={setSortBy}
      onExport={handleExport}
      filteredStudyCodes={filteredStudyCodes}
      selectedStudyCodes={selectedStudyCodes}
      onSelectStudyCode={handleSelectStudyCode}
      onSelectAll={handleSelectAll}
      onStudyCodeClick={handleStudyCodeClick}
      onClearSelection={() => setSelectedStudyCodes(new Set())}
      onDeleteSelected={handleDeleteSelected}
      onLogout={async () => {
        await logoutAdmin();
        router.push('/admin/login');
      }}
      onBackHome={() => router.push('/')}
      actionFeedback={actionFeedback}
      showDeleteModal={showDeleteModal}
      onCloseDeleteModal={() => setShowDeleteModal(false)}
      onConfirmDelete={confirmDelete}
      isDeleting={isDeleting}
      deleteTarget={deleteTarget}
    />
  );
}
