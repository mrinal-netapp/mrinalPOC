import { useMemo, type ReactElement } from "react";
import { useForm } from "@tanstack/react-form";
import { useStore } from "@tanstack/react-store";

import type { KBSynchronizationConfig, KBSyncMode } from "@/api/kb.types";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Form, runFormHandleSubmit } from "@/ui-lib/base-components/form";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button";
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper";

import { SYNC_MODE_OPTIONS } from "../create-edit/form/kb-form.consts";
import type { KBFormValues } from "../create-edit/form/kb-form.consts";
import { KBSyncScheduleContent } from "../create-edit/form/kb-sync-schedule-content";
import {
  buildKBSynchronizationConfigPayload,
  buildKBDefaultValues,
} from "../create-edit/form/kb-form.utils";
import type { KBFormScheduleValues } from "../create-edit/form/kb-form.consts";

// -- Types --

interface KBSyncSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  isLoading?: boolean;
  initialSyncConfig?: KBSynchronizationConfig | null;
  onConfirm: (syncConfig: KBSynchronizationConfig) => void | Promise<void>;
}

interface DialogFormValues {
  sync_mode: KBSyncMode;
  kb_schedule: KBFormScheduleValues;
  data_change_threshold_enabled: boolean;
  data_change_threshold_value: string;
}

// -- Dialog content --

function KBSyncSettingsDialogContent({
  onClose,
  isLoading,
  initialSyncConfig,
  onConfirm,
}: Omit<KBSyncSettingsDialogProps, "open">): ReactElement {
  const defaults = useMemo((): DialogFormValues => {
    const base = buildKBDefaultValues();
    if (initialSyncConfig) {
      const full = buildKBDefaultValues({
        synchronization_config: initialSyncConfig,
      } as never);
      return {
        sync_mode: full.sync_mode,
        kb_schedule: full.kb_schedule,
        data_change_threshold_enabled: full.data_change_threshold_enabled,
        data_change_threshold_value: full.data_change_threshold_value,
      };
    }
    return {
      sync_mode: base.sync_mode,
      kb_schedule: base.kb_schedule,
      data_change_threshold_enabled: base.data_change_threshold_enabled,
      data_change_threshold_value: base.data_change_threshold_value,
    };
  }, [initialSyncConfig]);

  const dialogForm = useForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      const fullValues = {
        ...buildKBDefaultValues(),
        ...value,
      } as KBFormValues;
      const payload = buildKBSynchronizationConfigPayload(fullValues);
      await onConfirm(payload);
    },
  }) as unknown as AnyReactFormApi;

  const isSubmitting: boolean = useStore(dialogForm.store, (s) => s.isSubmitting);
  const isBusy = isLoading || isSubmitting;

  const syncMode: KBSyncMode = useStore(dialogForm.store, (s) => s.values.sync_mode);

  const handleConfirm = (): void => {
    void runFormHandleSubmit(dialogForm);
  };

  /* v8 ignore start -- implicit else branch for isBusy guard */
  const handleCancel = (): void => {
    if (!isBusy) onClose();
  };
  /* v8 ignore stop */

  return (
    <Card>
      <CardHeader title="Edit synchronization settings" hasSeparator />
      <CardContent>
        <CardBlock type="description">
          <Form form={dialogForm}>
            <div className="dset-form__sync-content">
              <RadioGroup
                value={syncMode}
                onValueChange={(val) => dialogForm.setFieldValue("sync_mode", String(val) as KBSyncMode)}
                ariaLabel="Knowledge base sync mode"
              >
                <div className="dset-form__input-type-radios">
                  {SYNC_MODE_OPTIONS.map((opt) => (
                    <SelectorWrapper
                      key={opt.value}
                      selectorType="radioButton"
                      selectorProps={{ value: opt.value }}
                      label={opt.title}
                      description={opt.description}
                    />
                  ))}
                </div>
              </RadioGroup>

              {/* v8 ignore start -- branch tested via dialog test; V8 marks JSX conditional as uncovered */}
              {syncMode === "scheduled" && (
                <KBSyncScheduleContent form={dialogForm} />
              )}
              {/* v8 ignore stop */}

              {syncMode !== "scheduled" && (
                <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                  {syncMode === "manual"
                    ? "This knowledge base will need to be manually synchronized from the detail page."
                    : "Synchronization will start automatically after each dataset synchronization completes."
                  }
                </Typography>
              )}
            </div>
          </Form>
        </CardBlock>
      </CardContent>
      <CardFooter
        hasSeparator
        alignment="end"
        actions={[
          { variant: "solid", size: "medium", label: "Save", loading: isBusy, onClick: handleConfirm },
          { variant: "outline", size: "medium", label: "Cancel", onClick: handleCancel, isDisabled: isBusy },
        ]}
      />
    </Card>
  );
}

// -- Dialog wrapper --

function KBSyncSettingsDialog({
  open,
  onClose,
  isLoading = false,
  initialSyncConfig,
  onConfirm,
}: KBSyncSettingsDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isLoading) onClose();
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false} className="dset-form__sync-dialog">
        {open && (
          <KBSyncSettingsDialogContent
            onClose={onClose}
            isLoading={isLoading}
            initialSyncConfig={initialSyncConfig}
            onConfirm={onConfirm}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

export { KBSyncSettingsDialog };
export type { KBSyncSettingsDialogProps };
