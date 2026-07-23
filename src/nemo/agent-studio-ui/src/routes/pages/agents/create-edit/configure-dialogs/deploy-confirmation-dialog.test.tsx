import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SkippedDependency } from "../form/template-agent.utils";

import { DeployConfirmationDialog } from "./deploy-confirmation-dialog";

vi.mock("@/ui-lib/base-components/dialog/dialog", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/ui-lib/base-components/dialog/dialog")
  >();

  return {
    ...actual,
    Dialog: ({
      children,
      onOpenChange,
      ...props
    }: React.ComponentProps<typeof actual.Dialog>) => (
      <actual.Dialog {...props} onOpenChange={onOpenChange}>
        <button
          type="button"
          aria-label="simulate dialog open"
          onClick={() => onOpenChange?.(true, undefined, undefined)}
        />
        {children}
      </actual.Dialog>
    ),
  };
});

vi.setConfig({ testTimeout: 60_000 });

const SKIPPED: SkippedDependency[] = [
  { kind: "Knowledge base", label: "Optional KB" },
  { kind: "Toolset", label: "Optional MCP" },
];

describe("DeployConfirmationDialog", () => {
  it("renders the deploy copy and lists skipped optional dependencies", () => {
    render(
      <DeployConfirmationDialog
        open
        skippedDependencies={SKIPPED}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("Save and deploy agent")).toBeInTheDocument();
    expect(
      screen.getByText(/unresolved dependencies will be skipped or ignored/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Knowledge base: Optional KB/)).toBeInTheDocument();
    expect(screen.getByText(/Toolset: Optional MCP/)).toBeInTheDocument();
  });

  it("keeps deploy disabled until the user acknowledges the skipped dependencies", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <DeployConfirmationDialog
        open
        skippedDependencies={SKIPPED}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const deployButton = screen.getByRole("button", { name: "Save and deploy" });
    expect(deployButton).toBeDisabled();

    await user.click(screen.getByRole("checkbox"));
    expect(deployButton).not.toBeDisabled();

    await user.click(deployButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("resets acknowledgment and calls onClose when the dialog is dismissed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <DeployConfirmationDialog
        open
        skippedDependencies={SKIPPED}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save and deploy" })).not.toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("calls onClose from Cancel and hides the skipped list when there are none", () => {
    const onClose = vi.fn();
    render(
      <DeployConfirmationDialog
        open
        skippedDependencies={[]}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/unresolved dependencies will be skipped or ignored/i),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss or reset acknowledgment when the dialog reports an open event", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <DeployConfirmationDialog
        open
        skippedDependencies={SKIPPED}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save and deploy" })).not.toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: "simulate dialog open", hidden: true }),
    );

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save and deploy" })).not.toBeDisabled();
  });

  it("disables deploy again when the acknowledgment checkbox is unchecked", async () => {
    const user = userEvent.setup();

    render(
      <DeployConfirmationDialog
        open
        skippedDependencies={SKIPPED}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const deployButton = screen.getByRole("button", { name: "Save and deploy" });
    const checkbox = screen.getByRole("checkbox");

    await user.click(checkbox);
    expect(deployButton).not.toBeDisabled();

    await user.click(checkbox);
    expect(deployButton).toBeDisabled();
  });

});
