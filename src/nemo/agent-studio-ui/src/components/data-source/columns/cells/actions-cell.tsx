import type { MouseEvent, ReactNode } from "react";
import { IconDotsVertical } from "@tabler/icons-react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { Button } from "@/ui-lib/base-components/button/button";

interface ActionMenuItem<T> {
  label: string;
  // Receives the click event so handlers can inspect the activated element
  // (e.g. a DOM-marker-based activation guard). The event is optional so
  // existing zero/one-arg handlers stay compatible.
  onClick: (row: T, event?: MouseEvent<HTMLElement>) => void;
  isDisabled?: boolean;
  // Announces a disabled/locked state to assistive tech without using the
  // framework `disabled` prop (which would sever `onClick`).
  ariaDisabled?: boolean;
  icon?: ReactNode;
  className?: string;
}

interface ActionsCellProps<T> {
  row: T;
  name: string;
  isDisabled?: boolean;
  menuItems: ActionMenuItem<T>[];
}

function ActionsCell<T>({ row, name, isDisabled, menuItems }: ActionsCellProps<T>) {
  if (isDisabled) {
    return (
      <Button
        variant="icon"
        icon={<IconDotsVertical size={18} />}
        isDisabled
        aria-label={`Actions for ${name}`}
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="icon"
            icon={<IconDotsVertical size={18} />}
            aria-label={`Actions for ${name}`}
          />
        }
      />
      <DropdownMenuContent side="bottom" align="end">
        {menuItems.map((item) => (
          <DropdownMenuItem
            key={item.label}
            className={item.className}
            disabled={item.isDisabled}
            // Only force aria-disabled for the "locked" case; otherwise let the
            // `disabled` prop drive the accessible state (passing an explicit
            // undefined here would override Base UI's own aria-disabled).
            {...(item.ariaDisabled ? { "aria-disabled": true } : {})}
            onClick={(event) => item.onClick(row, event as MouseEvent<HTMLElement>)}
          >
            {item.icon}
            <Typography Component="span" fontSize="fs14" boldness="regular">
              {item.label}
            </Typography>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { ActionsCell };
export type { ActionMenuItem, ActionsCellProps };
