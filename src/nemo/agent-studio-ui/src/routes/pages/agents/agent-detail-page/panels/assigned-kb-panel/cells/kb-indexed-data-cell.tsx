import { useMemo, type ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";

import type { KnowledgeBaseIndexedData } from "../assigned-kb-panel.types";
import { ASSIGNED_KB_PANEL_STRINGS } from "../assigned-kb-panel.consts";

interface KbIndexedDataCellProps {
  indexed: KnowledgeBaseIndexedData;
}

function KbIndexedDataCell({ indexed }: KbIndexedDataCellProps): ReactElement {
  // I18-002: locale comes from the browser today. Swap the first arg to
  // `i18n.language` once an i18n provider lands.
  const numberFmt = useMemo(() => new Intl.NumberFormat(), []);

  const text = `${numberFmt.format(indexed.fileCount)} ${ASSIGNED_KB_PANEL_STRINGS.INDEXED_FILES_SUFFIX} / ${numberFmt.format(indexed.vectorCount)} ${ASSIGNED_KB_PANEL_STRINGS.INDEXED_VECTORS_SUFFIX}`;

  return (
    <Typography Component="span" fontSize="fs14" boldness="regular">
      {text}
    </Typography>
  );
}

export { KbIndexedDataCell };
export type { KbIndexedDataCellProps };
