import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TEMPLATE_REQUIRED_LABEL } from "../configure-dialogs/template-agent-config-dialog/template-agent-config-dialog.consts";
import { TemplateRequiredLabel } from "./template-required-label";

describe("TemplateRequiredLabel", () => {
  it("renders the required label copy", () => {
    render(<TemplateRequiredLabel />);
    expect(screen.getByText(TEMPLATE_REQUIRED_LABEL)).toBeInTheDocument();
  });
});
