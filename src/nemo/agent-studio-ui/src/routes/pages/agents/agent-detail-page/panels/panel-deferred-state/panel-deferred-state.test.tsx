import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { PanelDeferredState } from "./panel-deferred-state";
import { PANEL_DEFERRED_STATE_STRINGS } from "./panel-deferred-state.consts";

describe("PanelDeferredState", () => {
  it("[tag:panel-deferred-state] renders a status banner with the resource label in the title", () => {
    render(<PanelDeferredState resourceLabel="Toolsets" />);

    const banner = screen.getByRole("status");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(
      `${PANEL_DEFERRED_STATE_STRINGS.TITLE_PREFIX} Toolsets`,
    );
  });

  it("[tag:panel-deferred-state] renders the shared explanatory body copy", () => {
    render(<PanelDeferredState resourceLabel="Anything" />);

    expect(
      screen.getByText(PANEL_DEFERRED_STATE_STRINGS.BODY),
    ).toBeInTheDocument();
  });

  it("[tag:panel-deferred-state] hides the decorative icon from assistive tech", () => {
    const { container } = render(
      <PanelDeferredState resourceLabel="Toolsets" />,
    );

    expect(
      container.querySelector(".panel-deferred-state__icon"),
    ).toHaveAttribute("aria-hidden", "true");
  });
});
