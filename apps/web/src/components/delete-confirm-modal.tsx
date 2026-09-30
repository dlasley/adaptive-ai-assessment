import ConfirmationModal from '@/components/confirmation-modal';
import type { DeleteTarget } from '@/hooks/use-admin-study-codes';

export interface DeleteConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
  deleteTarget: DeleteTarget;
  selectedCount: number;
}

/** Shared confirmation dialog for both the single-student delete (student detail view) and the
 * bulk delete (study code table's selection bar) — the only difference is the title/message
 * wording, driven by `deleteTarget.type`. */
export function DeleteConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  deleteTarget,
  selectedCount,
}: DeleteConfirmModalProps) {
  const isSingle = deleteTarget.type === 'single';
  return (
    <ConfirmationModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title={isSingle ? 'Delete Student?' : `Delete ${selectedCount} Student${selectedCount !== 1 ? 's' : ''}?`}
      message={
        isSingle
          ? 'This will permanently delete this student and all their quiz history. This action cannot be undone.'
          : `This will permanently delete ${selectedCount} student${selectedCount !== 1 ? 's' : ''} and all their quiz history. This action cannot be undone.`
      }
      confirmText="Delete"
      variant="danger"
      isLoading={isLoading}
    />
  );
}
