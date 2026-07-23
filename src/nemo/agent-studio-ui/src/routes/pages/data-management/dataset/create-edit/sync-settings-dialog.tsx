import { useMemo, type ReactElement } from "react";
import { useForm } from "@tanstack/react-form";
import { useStore } from "@tanstack/react-store";

import type { DatasetRefreshConfig } from "@/api/dataset.types";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Form, runFormHandleSubmit } from "@/ui-lib/base-components/form";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { SyncSettingsContent } from "./sync-settings-content";
import { buildDefaultValues, buildRefreshConfigPayload, toBuilderScheduleType } from "./form/dataset-form.utils";
import { validateSyncSettingsDialogOnSubmit } from "./form/dataset-form.validation";

interface SyncSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  isLoading?: boolean;
  initialRefreshConfig?: DatasetRefreshConfig | null;
  onConfirm: (refreshConfig: DatasetRefreshConfig) => void | Promise<void>;
}

function SyncSettingsDialogContent({
  onClose,
  isLoading,
  initialRefreshConfig,
  onConfirm,
}: Omit<SyncSettingsDialogProps, "open">): ReactElement {
  const defaults = useMemo(() => {
    const base = buildDefaultValues();
    if (initialRefreshConfig) {
      base.sync_enabled = initialRefreshConfig.auto_refresh_enabled;
      base.sync_schedule_mode = initialRefreshConfig.schedule_type === "cron" ? "cron" : "builder";
      base.refresh_config.schedule_type = toBuilderScheduleType(initialRefreshConfig.schedule_type);
      base.refresh_config.interval_minutes = initialRefreshConfig.interval_minutes ?? 1;
      base.refresh_config.cron_expression = initialRefreshConfig.cron_expression ?? "";
      base.refresh_config.paused = initialRefreshConfig.paused;
      if (initialRefreshConfig.time_of_day) {
        const parts = initialRefreshConfig.time_of_day.split(":");
        base.refresh_config.time_of_day_hour = Number(parts[0]) || 0;
        base.refresh_config.time_of_day_minute = Number(parts[1]) || 0;
      }
      if (initialRefreshConfig.day_of_week) {
        base.refresh_config.day_of_week = initialRefreshConfig.day_of_week;
      }
      if (initialRefreshConfig.day_of_month != null) {
        base.refresh_config.day_of_month = initialRefreshConfig.day_of_month;
      }
    }
    return base;
  }, [initialRefreshConfig]);

  const dialogForm = useForm({
    defaultValues: defaults,
    validators: {
      onSubmit: validateSyncSettingsDialogOnSubmit,
    },
    onSubmit: async ({ value }) => {
      const payload = buildRefreshConfigPayload(value);
      if (payload) {
        await onConfirm(payload);
      }
    },
  }) as unknown as AnyReactFormApi;

  const isSubmitting: boolean = useStore(dialogForm.store, (s) => s.isSubmitting);
  /* v8 ignore start -- @preserve isSubmitting short-circuit: both handleCancel outcomes tested via isLoading */
  const isBusy = isLoading || isSubmitting;
  /* v8 ignore stop */

  const handleConfirm = (): void => {
    void runFormHandleSubmit(dialogForm);
  };

  /* v8 ignore next 3 -- @preserve isBusy=true via isSubmitting is untestable (form-internal); both outcomes exercised via isLoading prop */
  const handleCancel = (): void => {
    if (!isBusy) onClose();
  };

  return (
    <Card>
      <CardHeader title="Edit synchronization schedule" hasSeparator />
      <CardContent>
        <CardBlock type="description">
          <Form form={dialogForm}>
            <SyncSettingsContent form={dialogForm} />
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

function SyncSettingsDialog({
  open,
  onClose,
  isLoading = false,
  initialRefreshConfig,
  onConfirm,
}: SyncSettingsDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        /* v8 ignore else -- @preserve */ // nextOpen=true only fires from an open-trigger; controlled dialog has none
        if (!nextOpen && !isLoading) onClose();
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false} className="dset-form__sync-dialog">
        {open && (
          <SyncSettingsDialogContent
            onClose={onClose}
            isLoading={isLoading}
            initialRefreshConfig={initialRefreshConfig}
            onConfirm={onConfirm}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

export { SyncSettingsDialog };
export type { SyncSettingsDialogProps };
