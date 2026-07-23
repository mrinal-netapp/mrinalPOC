import { useState, type ReactElement } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";

import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { Checkbox } from "@/ui-lib/base-components/checkbox/checkbox";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import type { SkippedDependency } from "../form/template-agent.utils";

import "./deploy-confirmation-dialog.scss";

type DeployConfirmationDialogProps = {
  open: boolean;
  /** Unconfigured optional dependencies that will be skipped on deploy. */
  skippedDependencies: SkippedDependency[];
  onClose: () => void;
  onConfirm: () => void;
};

const STRINGS = {
  TITLE: "Save and deploy agent",
  DESCRIPTION:
    "This action will save your changes and immediately deploy this agent version to live production traffic.",
  SKIPPED_INTRO: "If you proceed, the following unresolved dependencies will be skipped or ignored:",
  ACKNOWLEDGE:
    "I understand that missing dependencies will be skipped and may cause production errors",
  CONFIRM: "Save and deploy",
  CANCEL: "Cancel",
} as const;

/**
 * Confirmation shown after the user enters identity for a template "Save and
 * deploy". Lists the unconfigured optional dependencies that will be skipped
 * and gates the deploy action behind an explicit acknowledgment.
 */
function DeployConfirmationDialog({
  open,
  skippedDependencies,
  onClose,
  onConfirm,
}: DeployConfirmationDialogProps): ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setAcknowledged(false);
          onClose();
        }
      }}
      size="md"
    >
      <DialogPopup showCloseButton={false}>
        <Card className="deploy-confirmation-dialog">
          <CardHeader title={STRINGS.TITLE} hasSeparator />

          <CardContent>
            <div className="deploy-confirmation-dialog__content">
              <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                {STRINGS.DESCRIPTION}
              </Typography>

              {skippedDependencies.length > 0 && (
                <div className="deploy-confirmation-dialog__skipped">
                  <span className="deploy-confirmation-dialog__skipped-intro">
                    <IconAlertTriangle
                      size={16}
                      className="deploy-confirmation-dialog__warning-icon"
                      aria-hidden="true"
                    />
                    <Typography fontSize="fs14">{STRINGS.SKIPPED_INTRO}</Typography>
                  </span>
                  <ul className="deploy-confirmation-dialog__skipped-list">
                    {skippedDependencies.map((dep, index) => (
                      <li key={`${dep.kind}-${dep.label}-${index}`}>
                        <Typography fontSize="fs14">
                          {dep.kind}: {dep.label}
                        </Typography>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <label className="deploy-confirmation-dialog__acknowledge">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked)}
                  aria-label={STRINGS.ACKNOWLEDGE}
                />
                <Typography fontSize="fs14">{STRINGS.ACKNOWLEDGE}</Typography>
              </label>
            </div>
          </CardContent>

          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: STRINGS.CONFIRM,
                onClick: () => {
                  setAcknowledged(false);
                  onConfirm();
                },
                isDisabled: !acknowledged,
              },
              {
                variant: "outline",
                label: STRINGS.CANCEL,
                onClick: () => {
                  setAcknowledged(false);
                  onClose();
                },
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  );
}

export { DeployConfirmationDialog };
export type { DeployConfirmationDialogProps };
