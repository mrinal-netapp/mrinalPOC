import type { ReactElement } from "react";

import { CardBlockLabel, CardBlockValue } from "@/ui-lib/base-components/card/card.block";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import type { PlaygroundRunStatisticsViewModel } from "../../agent-playground-statistics.utils";
import "./run-details-statistics-tab.scss";

type RunDetailsStatisticsTabProps = {
  statistics: PlaygroundRunStatisticsViewModel;
};

function StatRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="run-details-statistics__row">
      <CardBlockLabel>{label}</CardBlockLabel>
      <CardBlockValue>{value}</CardBlockValue>
    </div>
  );
}

function RunDetailsStatisticsTab({
  statistics,
}: RunDetailsStatisticsTabProps): ReactElement {
  if (statistics.isEmpty) {
    return (
      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
        Send a message in Chat to see statistics for the latest run.
      </Typography>
    );
  }

  return (
    <div className="run-details-statistics">
      {statistics.sections.map((section) => (
        <section key={section.title} className="run-details-statistics__section">
          <Typography
            Component="h3"
            fontSize="fs14"
            boldness="semibold"
            className="run-details-statistics__section-title"
          >
            {section.title}
          </Typography>
          <div className="run-details-statistics__rows">
            {section.rows.map((row) => (
              <StatRow key={row.label} label={row.label} value={row.value} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export { RunDetailsStatisticsTab };
export type { RunDetailsStatisticsTabProps };
