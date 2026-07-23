import type { ReactElement } from "react";

import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { PROJECT_DELETE_STRINGS } from "../create-edit/project-form.consts";
import "./project-delete-dialog.scss";

interface ProjectDeleteDialogProps {
  open: boolean;
  projectName: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ProjectDeleteDialog({
  open,
  projectName,
  loading = false,
  onConfirm,
  onCancel,
}: ProjectDeleteDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (loading) return;
        if (!nextOpen) onCancel();
      }}
      size="md"
    >
      <DialogPopup showCloseButton={false} className="project-delete-dialog">
        <Card>
          <CardHeader title={PROJECT_DELETE_STRINGS.DIALOG_TITLE} hasSeparator />
          <CardContent>
            <CardBlock type="description" className="project-delete-dialog__body">
              <Typography Component="p" fontSize="fs14" boldness="regular">
                {PROJECT_DELETE_STRINGS.CONFIRM_DESCRIPTION_PREFIX}
                {" "}
                <Typography Component="span" fontSize="fs14" boldness="semibold">
                  {projectName}
                </Typography>
                {PROJECT_DELETE_STRINGS.CONFIRM_DESCRIPTION_SUFFIX}
              </Typography>
              <Typography Component="p" fontSize="fs14" boldness="regular" className="project-delete-dialog__warning">
                {PROJECT_DELETE_STRINGS.UNDO_WARNING}
              </Typography>
            </CardBlock>
          </CardContent>
          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: PROJECT_DELETE_STRINGS.CONFIRM_LABEL,
                loading,
                onClick: onConfirm,
              },
              {
                variant: "outline",
                label: PROJECT_DELETE_STRINGS.CANCEL_LABEL,
                onClick: onCancel,
                isDisabled: loading,
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  );
}

export { ProjectDeleteDialog };
export type { ProjectDeleteDialogProps };
