import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { DatasetStatusCell, SyncStatusCell } from "./status-cell";

describe("dataset status cells", () => {
  it("renders SyncStatusCell without tooltip when sync did not fail", () => {
    renderWithProviders(
      <SyncStatusCell status="Completed" errorMessage="should not show" />,
    );

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy error message" })).not.toBeInTheDocument();
  });

  it("shows copy affordance for failed sync status with an error message", async () => {
    const errorMessage = "acquisition activity failed: SQL syntax error";
    const user = userEvent.setup();

    renderWithProviders(
      <SyncStatusCell status="Failed" errorMessage={errorMessage} />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "Failed" }));

    const copyButton = await screen.findByRole("button", { name: "Copy error message" });
    expect(screen.getByText(errorMessage)).toBeInTheDocument();
    expect(copyButton).toBeInTheDocument();
  });

  it("shows copy affordance for failed dataset status with an error message", async () => {
    const errorMessage = "acquisition activity failed: forbidden";
    const user = userEvent.setup();

    renderWithProviders(
      <DatasetStatusCell status="Failed" errorMessage={errorMessage} />,
    );

    await user.hover(screen.getByRole("button", { name: "Failed" }));

    expect(await screen.findByText(errorMessage)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy error message" })).toBeInTheDocument();
  });

  it("renders '—' for manual upload datasets with Never sync status in list variant", () => {
    renderWithProviders(
      <SyncStatusCell status="Never" inputType="upload" variant="list" />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Never synced")).not.toBeInTheDocument();
  });

  it("renders 'Disabled' for manual upload datasets with Never sync status in sync variant", () => {
    renderWithProviders(
      <SyncStatusCell status="Never" inputType="upload" variant="sync" />,
    );

    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Never synced")).not.toBeInTheDocument();
  });

  it("renders 'Completed' for manual upload import status when import finished", () => {
    renderWithProviders(
      <SyncStatusCell status="Never" inputType="upload" variant="import" />,
    );

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("Never synced")).not.toBeInTheDocument();
    expect(screen.queryByText("Disabled")).not.toBeInTheDocument();
  });

  it("renders '—' for manual upload datasets with Completed sync status in list variant", () => {
    renderWithProviders(
      <SyncStatusCell status="Completed" inputType="upload" variant="list" />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("renders '—' for manual upload datasets with Failed sync status in list variant", () => {
    renderWithProviders(
      <SyncStatusCell status="Failed" inputType="upload" variant="list" errorMessage="import failed" />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("renders '—' for manual upload datasets during import on the list", () => {
    renderWithProviders(
      <SyncStatusCell status="Synchronizing" inputType="upload" variant="list" />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Synchronizing")).not.toBeInTheDocument();
  });

  it("renders 'Disabled' for manual upload datasets during import on the sync tab", () => {
    renderWithProviders(
      <SyncStatusCell status="Synchronizing" inputType="upload" variant="sync" />,
    );

    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Synchronizing")).not.toBeInTheDocument();
  });

  it("renders 'Synchronizing' on the import status header while import runs", () => {
    renderWithProviders(
      <SyncStatusCell status="Synchronizing" inputType="upload" variant="import" />,
    );

    expect(screen.getByText("Synchronizing")).toBeInTheDocument();
  });
});
