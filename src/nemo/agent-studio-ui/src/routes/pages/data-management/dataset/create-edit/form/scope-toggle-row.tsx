import type { ReactElement } from "react";

import { cn } from "@/ui-lib/lib/utils";
import { Toggle } from "@/ui-lib/base-components/toggle/toggle";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Tooltip } from "@/ui-lib/base-components/tooltip/tooltip";

/** Shown when a scope toggle is disabled because the data source type doesn't support it. */
export const SCOPE_UNSUPPORTED_MESSAGE = "Not Supported for selected data source scope.";

interface ScopeToggleRowProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** When true the toggle is disabled and an explanatory tooltip is shown on hover/focus. */
  disabled: boolean;
  /** Override the default disabled tooltip when the scope is unavailable. */
  disabledTooltip?: string;
  label: string;
  ariaLabel: string;
}

/**
 * A scope toggle ("Apply folder/file/schema scope") with its label. When the
 * scope isn't supported by the selected data source the toggle is disabled and
 * the whole row becomes a tooltip trigger explaining why — disabled controls
 * don't emit hover events themselves, so the (non-disabled) row wrapper is the
 * trigger instead.
 */
function ScopeToggleRow({
  checked,
  onCheckedChange,
  disabled,
  disabledTooltip,
  label,
  ariaLabel,
}: ScopeToggleRowProps): ReactElement {
  const row = (
    <div
      className={cn(
        "dset-form__scope-toggle-row",
        disabled && "dset-form__scope-toggle-row--disabled",
      )}
    >
      <Toggle
        checked={checked}
        onCheckedChange={onCheckedChange}
        isDisabled={disabled}
        ariaLabel={ariaLabel}
      />
      <Typography Component="span" fontSize="fs14" boldness="regular" isDisabled={disabled}>
        {label}
      </Typography>
    </div>
  );

  if (!disabled) {
    return row;
  }

  return <Tooltip content={disabledTooltip ?? SCOPE_UNSUPPORTED_MESSAGE} trigger={row} />;
}

export { ScopeToggleRow };
export type { ScopeToggleRowProps };
