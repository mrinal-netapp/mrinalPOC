import type { ReactElement } from "react";

import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { ADMINISTRATION_MEMBERS_STRINGS } from "./administration-members.consts";

interface MemberDeleteDialogProps {
  open: boolean;
  memberName: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function MemberDeleteDialog({
  open,
  memberName,
  loading = false,
  onConfirm,
  onCancel,
}: MemberDeleteDialogProps): ReactElement {
  return (
    <ConfirmDialog
      open={open}
      title={ADMINISTRATION_MEMBERS_STRINGS.DELETE_DIALOG_TITLE}
      description={(
        <>
          {ADMINISTRATION_MEMBERS_STRINGS.DELETE_DESCRIPTION_PREFIX}
          {" "}
          <strong>{memberName}</strong>
          {ADMINISTRATION_MEMBERS_STRINGS.DELETE_DESCRIPTION_SUFFIX}
          <br />
          <br />
          {ADMINISTRATION_MEMBERS_STRINGS.DELETE_UNDO_WARNING}
        </>
      )}
      variant="danger"
      confirmLabel={ADMINISTRATION_MEMBERS_STRINGS.DELETE_CONFIRM_LABEL}
      cancelLabel={ADMINISTRATION_MEMBERS_STRINGS.DELETE_CANCEL_LABEL}
      loading={loading}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export { MemberDeleteDialog };
export type { MemberDeleteDialogProps };
