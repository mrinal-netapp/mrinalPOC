import type { ReactElement } from "react";

import type { DataSourceDetail } from "@/api/data-source.types";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlockKeyValueList } from "@/ui-lib/base-components/card/card.block";
import { buildDataSourceDetailRows } from "./data-source-detail-overview.utils";

interface DataSourceDetailOverviewProps {
  data: DataSourceDetail;
}

function DataSourceDetailOverview({ data }: DataSourceDetailOverviewProps): ReactElement {
  return (
    <Card>
      <CardContent>
        <CardBlockKeyValueList rows={buildDataSourceDetailRows(data)} />
      </CardContent>
    </Card>
  );
}

export { DataSourceDetailOverview };
export type { DataSourceDetailOverviewProps };
