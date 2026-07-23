import type { ReactElement, ReactNode } from "react";

type CellMarkerProps = {
  isDeprecated: boolean;
  children: ReactNode;
};

/**
 * `display: contents` marker — keeps the layout box tree intact while
 * exposing a queryable hook to the parent `<td>` via `:has()`. Used so a
 * single CSS rule can grey the whole cell when the row is deprecated,
 * without each cell having to know about the styling.
 *
 * Lifted into its own file so the column factory module
 * (`agents-list.columns.tsx`) exports only non-component values and stays
 * fast-refresh friendly.
 */
function CellMarker({ isDeprecated, children }: CellMarkerProps): ReactElement {
  return (
    <span
      className={`agent-list-row-marker${
        isDeprecated ? " agent-list-row-marker--deprecated" : ""
      }`}
    >
      {children}
    </span>
  );
}

export { CellMarker };
export type { CellMarkerProps };
