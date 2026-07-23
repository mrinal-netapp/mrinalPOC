import { Fragment, type ReactElement, type MouseEvent } from "react";
import { Link } from "react-router";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { Typography } from "@/ui-lib/base-components/typography/typography";

/** Minimal shape an item needs to render in the overflow list. */
interface OverflowListItem {
  id: string;
  name: string;
  /** When present the item renders as a react-router Link that opens in a new tab. */
  href?: string;
}

/** Max items rendered inline before collapsing the rest behind a "+N" control. */
const MAX_VISIBLE = 3;

interface OverflowListCellProps {
  items: OverflowListItem[];
}

/**
 * Renders a comma-separated list of named items, capped at {@link MAX_VISIBLE}.
 * Anything beyond the cap collapses into a clickable "+N" control that opens a
 * popover listing the remaining items. Used by the Models and Associated
 * columns on the agents list (single + team tabs).
 */
function OverflowListCell({ items }: OverflowListCellProps): ReactElement {
  if (items.length === 0) {
    return <span className="agent-list-cell-placeholder">—</span>;
  }

  const visibleItems = items.slice(0, MAX_VISIBLE);
  const overflowItems = items.slice(MAX_VISIBLE);
  const hasOverflow = overflowItems.length > 0;

  return (
    <div className="overflow-list-cell">
      {visibleItems.map((item, idx) => {
        const isLastVisible = idx === visibleItems.length - 1;
        return (
          <Fragment key={item.id}>
            <span className="overflow-list-cell__item">
              {item.href ? (
                <Link
                  to={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className="overflow-list-cell__link"
                >
                  <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                    {item.name}
                  </Typography>
                </Link>
              ) : (
                <Typography Component="span" fontSize="fs14" boldness="regular">
                  {item.name}
                </Typography>
              )}
            </span>
            {!isLastVisible && (
              <Typography
                Component="span"
                fontSize="fs14"
                boldness="regular"
                color="var(--text-secondary)"
                className="overflow-list-cell__separator"
              >
                ,
              </Typography>
            )}
          </Fragment>
        );
      })}

      {hasOverflow && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="overflow-list-cell__overflow"
            aria-label={`Show ${overflowItems.length} more`}
            // The row may have its own click handlers (e.g. navigation); keep
            // the "+N" interaction scoped to opening the overflow list.
            onClick={(event: MouseEvent<HTMLButtonElement>) => event.stopPropagation()}
          >
            <Typography
              Component="span"
              fontSize="fs14"
              boldness="regular"
              color="var(--text-button-primary)"
            >
              +{overflowItems.length}
            </Typography>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="overflow-list-cell__overflow-list"
            align="start"
          >
            {overflowItems.map((item) => (
              <DropdownMenuItem
                key={item.id}
                className="overflow-list-cell__overflow-item"
                {...(item.href && {
                  render: (
                    <Link
                      to={item.href}
                      target="_blank"
                      rel="noreferrer"
                      className="overflow-list-cell__link overflow-list-cell__overflow-link"
                    />
                  ),
                })}
              >
                {item.href ? (
                  <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                    {item.name}
                  </Typography>
                ) : (
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    {item.name}
                  </Typography>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export { OverflowListCell };
export type { OverflowListCellProps, OverflowListItem };
