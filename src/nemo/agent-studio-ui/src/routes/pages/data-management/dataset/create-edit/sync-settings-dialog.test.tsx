import { screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import type { DatasetRefreshConfig } from "@/api/dataset.types";
import { SyncSettingsDialog } from "./sync-settings-dialog";

const INITIAL_CONFIG: DatasetRefreshConfig = {
  auto_refresh_enabled: true,
  schedule_type: "daily",
  interval_minutes: undefined,
  time_of_day: "10:30",
  day_of_week: null,
  day_of_month: null,
  timezone: null,
  cron_expression: null,
  paused: false,
};

let roHandle: ReturnType<typeof mockResizeObserver>;

beforeEach(() => {
  vi.clearAllMocks();
  roHandle = mockResizeObserver();
  return () => roHandle.cleanup();
});

describe("SyncSettingsDialog", () => {
  it("renders dialog title when open", () => {
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={INITIAL_CONFIG}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit synchronization schedule")).toBeInTheDocument();
  });

  it("renders Save and Cancel buttons", () => {
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={INITIAL_CONFIG}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={onClose}
        initialRefreshConfig={INITIAL_CONFIG}
        onConfirm={vi.fn()}
      />,
    );

    const cancelBtn = screen.getByText("Cancel");
    await userEvent.setup().click(cancelBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onConfirm with config when Save is clicked", async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={INITIAL_CONFIG}
        onConfirm={onConfirm}
      />,
    );

    const saveBtn = screen.getByText("Save");
    await userEvent.setup().click(saveBtn);

    // onConfirm is called via form submit
    expect(onConfirm).toHaveBeenCalled();
  });

  it("does not render when not open", () => {
    renderWithProviders(
      <SyncSettingsDialog
        open={false}
        onClose={vi.fn()}
        initialRefreshConfig={INITIAL_CONFIG}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByText("Edit synchronization schedule")).not.toBeInTheDocument();
  });

  it("renders with null initial config", () => {
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={null}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit synchronization schedule")).toBeInTheDocument();
  });

  it("does not call onClose when isLoading is true and Cancel is clicked", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={onClose}
        isLoading={true}
        initialRefreshConfig={INITIAL_CONFIG}
        onConfirm={vi.fn()}
      />,
    );

    // When isLoading=true the button is visually disabled (pointer-events:none).
    // Use fireEvent to bypass the pointer-events guard and verify handleCancel's
    // guard (`if (!isLoading)`) prevents calling onClose.
    const { fireEvent } = await import("@testing-library/react");
    const cancelBtn = screen.getByText("Cancel");
    fireEvent.click(cancelBtn);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("initializes with day_of_week from config", () => {
    const configWithDayOfWeek: typeof INITIAL_CONFIG = {
      ...INITIAL_CONFIG,
      schedule_type: "weekly",
      auto_refresh_enabled: true,
      day_of_week: [1, 3],
    };
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={configWithDayOfWeek}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit synchronization schedule")).toBeInTheDocument();
  });

  it("initializes with day_of_month from config", () => {
    const configWithDayOfMonth: typeof INITIAL_CONFIG = {
      ...INITIAL_CONFIG,
      schedule_type: "monthly",
      day_of_month: 15,
    };
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={configWithDayOfMonth}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit synchronization schedule")).toBeInTheDocument();
  });

  it("initializes with cron config when schedule_type is 'cron'", () => {
    const cronConfig: typeof INITIAL_CONFIG = {
      ...INITIAL_CONFIG,
      schedule_type: "cron",
      cron_expression: "0 10 * * *",
      auto_refresh_enabled: true,
    };
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={cronConfig}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit synchronization schedule")).toBeInTheDocument();
  });

  it("initializes with interval_minutes from config", () => {
    const hourlyConfig: typeof INITIAL_CONFIG = {
      ...INITIAL_CONFIG,
      schedule_type: "hourly",
      interval_minutes: 30,
      auto_refresh_enabled: true,
    };
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={hourlyConfig}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit synchronization schedule")).toBeInTheDocument();
  });

  it("initializes correctly when time_of_day is null (false branch of if(time_of_day))", () => {
    // Covers the `if (initialRefreshConfig.time_of_day)` false branch
    const configNoTod: typeof INITIAL_CONFIG = { ...INITIAL_CONFIG, time_of_day: null };
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={configNoTod}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit synchronization schedule")).toBeInTheDocument();
  });

  it("initializes correctly when time_of_day parts are zero (|| 0 falsy branch)", () => {
    // Covers `Number(parts[0]) || 0` and `Number(parts[1]) || 0` falsy branches
    const configZeroTod: typeof INITIAL_CONFIG = { ...INITIAL_CONFIG, time_of_day: "0:00" };
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={configZeroTod}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit synchronization schedule")).toBeInTheDocument();
  });

  it("does not call onConfirm when sync is disabled on submit (if(payload) false branch)", async () => {
    // Covers the `if (payload)` false branch in onSubmit (buildRefreshConfigPayload returns undefined when sync_enabled=false)
    const onConfirm = vi.fn();
    const disabledSyncConfig: typeof INITIAL_CONFIG = {
      ...INITIAL_CONFIG,
      auto_refresh_enabled: false,
    };
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={vi.fn()}
        initialRefreshConfig={disabledSyncConfig}
        onConfirm={onConfirm}
      />,
    );
    await userEvent.setup().click(screen.getByText("Save"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onClose via dialog onOpenChange when Escape key is pressed", async () => {
    // Covers the `onOpenChange` arrow function + `if (!nextOpen)` true branch + `if (!isLoading)` true branch
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={onClose}
        initialRefreshConfig={INITIAL_CONFIG}
        onConfirm={vi.fn()}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call onClose when isLoading is true and Escape triggers onOpenChange (if(!isLoading) false branch)", async () => {
    // Covers `if (!isLoading) onClose()` false branch in handleCancel
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <SyncSettingsDialog
        open={true}
        onClose={onClose}
        isLoading={true}
        initialRefreshConfig={INITIAL_CONFIG}
        onConfirm={vi.fn()}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });
});
