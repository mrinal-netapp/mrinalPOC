import type { ReactElement, ReactNode } from "react";

import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Typography } from "@/ui-lib/base-components/typography/typography";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true the confirm button is omitted — useful for informational / blocked dialogs. */
  hideConfirm?: boolean;
  variant?: "default" | "danger";
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  hideConfirm = false,
  variant = "default",
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement {
  const confirmVariant = variant === "danger" ? "solid-destructive" as const : "solid" as const;

  const footerActions = hideConfirm
    ? [{ variant: "outline" as const, label: cancelLabel, onClick: onCancel, isDisabled: loading }]
    : [
        { variant: "outline" as const, label: cancelLabel, onClick: onCancel, isDisabled: loading },
        { variant: confirmVariant, label: confirmLabel, loading, onClick: onConfirm },
      ];

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        /* v8 ignore start -- controlled dialog: onOpenChange(true) never fires without an internal trigger */
        if (loading) return;
        if (!nextOpen) onCancel();
        /* v8 ignore stop */
        onOpenChange?.(nextOpen);
      }}
      size="sm"
    >
      <DialogPopup showCloseButton={false}>
        <Card>
          <CardHeader title={title} hasSeparator />
          <CardContent>
            <CardBlock type="description">
              <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                {description}
              </Typography>
            </CardBlock>
          </CardContent>
          <CardFooter hasSeparator alignment="center" actions={footerActions} />
        </Card>
      </DialogPopup>
    </Dialog>
  );
}

export { ConfirmDialog };
export type { ConfirmDialogProps };
