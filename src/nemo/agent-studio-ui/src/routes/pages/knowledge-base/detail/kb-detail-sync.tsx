import type { ReactElement } from "react";
import { IconRefresh } from "@tabler/icons-react";

import type { KBDetail, KBSynchronizationConfig } from "@/api/kb.types";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContentLayout } from "@/ui-lib/base-components/card/card.content-layout";
import { CardBlock, CardBlockLabel, CardBlockValue } from "@/ui-lib/base-components/card/card.block";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { SyncStatusCell } from "@/components/dataset/columns/cells/status-cell";
import { getScheduleLabel } from "@/components/dataset/utils/dataset.utils";
import "./kb-detail.scss";

interface KBDetailSyncProps {
  data: KBDetail;
}

function getKBScheduleLabel(config: KBSynchronizationConfig | null | undefined): string {
  if (!config) return "Manual";
  if (config.sync_mode === "manual") return "Manual";
  if (config.sync_mode === "after_dataset_updates") return "After dataset updates";

  return getScheduleLabel(config) ?? "Scheduled";
}

function KBDetailSync({ data }: KBDetailSyncProps): ReactElement {
  const syncSummary = data.synchronization_summary;

  return (
    <Card className="kb-sync__card">
      <CardHeader
        icon={<IconRefresh />}
        title="Synchronization schedule"
        hasSeparator
      />

      {/* v8 ignore start -- nullish ternary fallbacks for optional API summary fields */}
      <CardContentLayout columns={4}>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue className="kb-sync__status-value">
            {data.synchronization_status
              ? <SyncStatusCell status={data.synchronization_status} boldness="semibold" />
              : "—"
            }
          </CardBlockValue>
          <CardBlockLabel>Status</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue isEllipsis>
            {getKBScheduleLabel(data.synchronization_config)}
          </CardBlockValue>
          <CardBlockLabel>Schedule</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue isEllipsis>
            {syncSummary?.last_completed_synchronization
              ? formatDateTimeFull(syncSummary.last_completed_synchronization)
              : "—"}
          </CardBlockValue>
          <CardBlockLabel>Last completed synchronization</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric">
          <CardBlockValue isEllipsis>
            {syncSummary?.next_scheduled_synchronization
              ? formatDateTimeFull(syncSummary.next_scheduled_synchronization)
              : "—"}
          </CardBlockValue>
          <CardBlockLabel>Next scheduled synchronization</CardBlockLabel>
        </CardBlock>
      </CardContentLayout>
      {/* v8 ignore stop */}
    </Card>
  );
}

export { KBDetailSync };
export type { KBDetailSyncProps };
