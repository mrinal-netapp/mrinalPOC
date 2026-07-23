import type { ReactElement } from "react";

import type { ScanDepth } from "@/api/data-source.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Button } from "@/ui-lib/base-components/button/button";
import { getScanNotice } from "@/components/data-source/utils/scan-notice";

// -- Component --

interface ScanningSectionProps {
  scanDepth: ScanDepth;
  customDepth: number | null;
  onOpenDialog: () => void;
}

function ScanningSection({ scanDepth, customDepth, onOpenDialog }: ScanningSectionProps): ReactElement {
  const notice = getScanNotice(scanDepth, customDepth);
  const isEnabled = scanDepth !== "none";

  return (
    <section className="ds-form__section">
      <div className="ds-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-form__section-title">
          Scanning
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__section-subtitle">
          Scan this data source to pre-load metadata with real-time file statistics and visual folder browsing.
        </Typography>
      </div>

      <div className="ds-form__notice">
        <span className="ds-form__notice-icon">
          {notice.icon}
        </span>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__notice-text">
          {notice.text}
        </Typography>
      </div>

      <div>
        <Button
          variant="outline"
          label={isEnabled ? "Modify" : "Enable"}
          onClick={onOpenDialog}
        />
      </div>
    </section>
  );
}

export { ScanningSection };
export type { ScanningSectionProps };
