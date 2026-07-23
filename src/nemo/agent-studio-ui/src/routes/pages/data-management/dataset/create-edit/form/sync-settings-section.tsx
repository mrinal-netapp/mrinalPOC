import type { ReactElement } from "react";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { SyncSettingsContent } from "../sync-settings-content";

export const UPLOAD_SCHEDULE_DISABLED_MESSAGE =
  "Sync schedule cannot be enabled for manually uploaded datasets.";

interface SyncSettingsSectionProps {
  form: AnyReactFormApi;
  /** When true, scheduling controls are disabled (manual upload datasets). */
  scheduleDisabled?: boolean;
}

function SyncSettingsSection({ form, scheduleDisabled = false }: SyncSettingsSectionProps): ReactElement {
  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Refresh schedule
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          {scheduleDisabled
            ? UPLOAD_SCHEDULE_DISABLED_MESSAGE
            : "You can refresh this dataset manually anytime. Turn on a schedule to refresh automatically."}
        </Typography>
      </div>

      <SyncSettingsContent form={form} scheduleDisabled={scheduleDisabled} />
    </section>
  );
}

export { SyncSettingsSection };
export type { SyncSettingsSectionProps };
