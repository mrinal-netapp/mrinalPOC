import type { ReactElement } from "react";
import { IconCircleCheck, IconCircleMinus } from "@tabler/icons-react";

import type { ScanDepth } from "@/api/data-source.types";
import { SCAN_DEPTH_LABELS } from "./data-source.utils";

function getScanNotice(depth: ScanDepth, customDepth: number | null): { icon: ReactElement; text: string } {
  if (depth === "none") {
    return {
      icon: <IconCircleMinus size={16} style={{ color: "var(--text-disabled)" }} />,
      text: "Scanning is disabled on this data source.",
    };
  }

  const label = depth === "custom" && customDepth != null
    ? `top ${customDepth} folder levels`
    : SCAN_DEPTH_LABELS[depth].toLowerCase();

  return {
    icon: <IconCircleCheck size={16} style={{ color: "var(--notification-success)" }} />,
    text: `Scanning of ${label} enabled on this data source.`,
  };
}

export { getScanNotice };
