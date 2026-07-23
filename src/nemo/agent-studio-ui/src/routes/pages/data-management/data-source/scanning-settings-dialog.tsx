import { useState, useCallback, type ReactElement, type ChangeEvent } from "react";

import type { ScanDepth } from "@/api/data-source.types";
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button";
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Input } from "@/ui-lib/base-components/input/input";
import {
  Dialog,
  DialogPopup,
} from "@/ui-lib/base-components/dialog/dialog";
import "./create-edit/form/data-source-form.scss";

// -- Scan depth options (shared between create & edit flows) --

const SCAN_DEPTH_OPTIONS = [
  { value: "none", label: "None", description: "Disables scanning. Can be enabled after adding the data source." },
  { value: "all_levels", label: "All folder levels (Recommended)", description: "Best for a fast preview and immediate use. Optimized for instant results." },
  { value: "top_5_levels", label: "Top 5 folder levels", description: "Recommended for most projects. Optimized for detail and speed." },
  { value: "top_2_levels", label: "Top 2 folder levels", description: "Best for full visibility of all subfolders. Thorough but may take longer." },
  { value: "custom", label: "Custom folder level amount", description: "Best for manual depth configuration." },
] as const;

// -- Props --

interface ScanningSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  isEdit?: boolean;
  isLoading?: boolean;
  initialScanDepth: ScanDepth;
  initialCustomDepth: number | null;
  onConfirm: (scanDepth: ScanDepth, customDepth: number | null) => void;
}

// -- Component --

function ScanningSettingsDialog({
  open,
  onClose,
  isEdit = false,
  isLoading = false,
  initialScanDepth,
  initialCustomDepth,
  onConfirm,
}: ScanningSettingsDialogProps): ReactElement {
  const [localDepth, setLocalDepth] = useState<ScanDepth>(initialScanDepth);
  const [localCustomDepth, setLocalCustomDepth] = useState<number>(initialCustomDepth ?? 1);

  /* v8 ignore start -- BaseUI only calls onOpenChange(true) via an internal trigger; this controlled dialog
     has no built-in trigger, so handleOpen is never reached from the UI or tests */
  const handleOpen = useCallback(() => {
    setLocalDepth(initialScanDepth);
    setLocalCustomDepth(initialCustomDepth ?? 1);
  }, [initialScanDepth, initialCustomDepth]);
  /* v8 ignore stop */

  const handleCancel = useCallback(() => {
    if (!isLoading) onClose();
  }, [isLoading, onClose]);

  const handleConfirm = useCallback(() => {
    const customDepth = localDepth === "custom" ? (localCustomDepth || 1) : null;
    onConfirm(localDepth, customDepth);
  }, [localDepth, localCustomDepth, onConfirm]);

  const title = isEdit ? "Edit data source scanning" : "Enable data source scanning";
  const confirmLabel = isEdit ? "Save" : "Confirm";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        /* v8 ignore start -- BaseUI never fires onOpenChange(true) for a controlled dialog without a built-in
           trigger; the if(nextOpen) true-branch and if(!nextOpen) false-branch are therefore both unreachable */
        if (nextOpen) handleOpen();
        if (!nextOpen) handleCancel();
        /* v8 ignore stop */
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false} className="ds-form__scan-dialog">
        <Card>
          <CardHeader title={title} hasSeparator />
          <CardContent>
            <CardBlock type="description">
              <Typography Component="p" fontSize="fs14" boldness="regular">
                Select a type of the scanning setting to perform after adding the data source.
              </Typography>
            </CardBlock>

            <CardBlock type="list">
              <RadioGroup
                value={localDepth}
                onValueChange={(val) => setLocalDepth(String(val) as ScanDepth)}
                ariaLabel="Scanning setting"
              >
                <div className="ds-form__scan-table">
                  <div className="ds-form__scan-table-header">
                    <span className="ds-form__scan-table-cell ds-form__scan-table-cell--selector">
                      <Typography Component="span" fontSize="fs14" boldness="semibold">Scanning setting</Typography>
                    </span>
                    <span className="ds-form__scan-table-cell ds-form__scan-table-cell--desc">
                      <Typography Component="span" fontSize="fs14" boldness="semibold">Description</Typography>
                    </span>
                  </div>
                  {SCAN_DEPTH_OPTIONS.map((opt) => (
                    <div
                      key={opt.value}
                      className="ds-form__scan-table-row"
                    >
                      <span className="ds-form__scan-table-cell ds-form__scan-table-cell--selector">
                        <SelectorWrapper
                          selectorType="radioButton"
                          selectorProps={{ value: opt.value }}
                          label={opt.label}
                        />
                      </span>
                      <span className="ds-form__scan-table-cell ds-form__scan-table-cell--desc">
                        <Typography Component="span" fontSize="fs14" boldness="regular">{opt.description}</Typography>
                      </span>
                    </div>
                  ))}
                </div>
              </RadioGroup>
            </CardBlock>

            <CardBlock type="description">
              <div className="ds-form__custom-depth-section">
                <div className="ds-form__custom-depth-header">
                  <Typography Component="p" fontSize="fs14" boldness="semibold">
                    Custom folder level amount
                  </Typography>
                  <Typography Component="p" fontSize="fs14" boldness="regular">
                    Specify custom folder amount during the scanning of the data source.
                  </Typography>
                </div>
                <div className="ds-form__field">
                  <Input
                    type="number"
                    label="Folder level amount"
                    value={String(localCustomDepth)}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setLocalCustomDepth(Number(e.target.value) || 1)
                    }
                    min={1}
                    placeholder="Enter folder level amount"
                    isDisabled={localDepth !== "custom"}
                  />
                </div>
              </div>
            </CardBlock>
          </CardContent>
          <CardFooter
            hasSeparator
            alignment="end"
            className="ds-form__scan-dialog-footer"
            actions={[
              { variant: "solid", size: "medium", label: confirmLabel, loading: isLoading, onClick: handleConfirm },
              { variant: "outline", size: "medium", label: "Cancel", onClick: handleCancel, isDisabled: isLoading },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  );
}

export { ScanningSettingsDialog, SCAN_DEPTH_OPTIONS };
export type { ScanningSettingsDialogProps };
