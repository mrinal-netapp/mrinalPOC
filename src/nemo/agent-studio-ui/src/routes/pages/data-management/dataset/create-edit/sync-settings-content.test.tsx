import { screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import { useForm } from "@tanstack/react-form";
import { Form } from "@/ui-lib/base-components/form";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { buildDefaultValues } from "./form/dataset-form.utils";
import { validateSyncSettingsDialogOnSubmit } from "./form/dataset-form.validation";
import { SyncSettingsContent } from "./sync-settings-content";
import { runScheduleNumericRange } from "./sync-settings-content.utils";

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

type SyncDefaults = {
  syncEnabled?: boolean;
  syncScheduleMode?: "builder" | "cron";
  scheduleType?: "hourly" | "daily" | "weekly" | "monthly";
  /** Omit for `[]`. Pass `null` to cover `day_of_week ?? []` when the value is nullish. */
  dayOfWeek?: number[] | null;
};

function SyncWrapper({
  syncEnabled = true,
  syncScheduleMode = "builder",
  scheduleType = "daily",
  dayOfWeek,
  scheduleDisabled = false,
  withSubmit = false,
  withValidators = false,
}: SyncDefaults & {
  scheduleDisabled?: boolean;
  withSubmit?: boolean;
  withValidators?: boolean;
}): ReactElement {
  const defaults = buildDefaultValues();
  defaults.sync_enabled = syncEnabled;
  defaults.sync_schedule_mode = syncScheduleMode;
  defaults.refresh_config.schedule_type = scheduleType;
  if (dayOfWeek === undefined) {
    defaults.refresh_config.day_of_week = [];
  } else {
    (defaults.refresh_config as { day_of_week: number[] | null }).day_of_week = dayOfWeek;
  }

  const form = useForm({
    defaultValues: defaults,
    validators: withValidators ? { onSubmit: validateSyncSettingsDialogOnSubmit } : undefined,
    onSubmit: async () => { },
  }) as unknown as AnyReactFormApi;

  return (
    <Form form={form}>
      <SyncSettingsContent form={form} scheduleDisabled={scheduleDisabled} />
      {withSubmit && <button type="submit">Submit</button>}
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let roCleanup: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  roCleanup = mockResizeObserver().cleanup;
});

afterEach(() => {
  roCleanup?.();
});

// ---------------------------------------------------------------------------
// runScheduleNumericRange — unit tests
// ---------------------------------------------------------------------------

describe("runScheduleNumericRange", () => {
  it("returns required message when value is null (null branch)", () => {
    expect(runScheduleNumericRange(null, 0, 59, "Minute")).toBe("Minute is required");
  });

  it("returns required message when value is undefined (undefined branch)", () => {
    expect(runScheduleNumericRange(undefined, 0, 59, "Minute")).toBe("Minute is required");
  });
});

// ---------------------------------------------------------------------------
// Sync disabled
// ---------------------------------------------------------------------------

describe("SyncSettingsContent — sync disabled", () => {
  it("renders the sync enable checkbox", () => {
    renderWithProviders(<SyncWrapper syncEnabled={false} />);
    expect(
      screen.getByText("Enable dataset refresh schedule"),
    ).toBeInTheDocument();
  });

  it("renders the sync notice container when sync is disabled", () => {
    renderWithProviders(<SyncWrapper syncEnabled={false} />);
    expect(document.querySelector(".dset-form__sync-notice")).toBeInTheDocument();
  });

  it("does not show the tab group when sync is disabled", () => {
    renderWithProviders(<SyncWrapper syncEnabled={false} />);
    expect(screen.queryByText("Use schedule builder")).not.toBeInTheDocument();
  });

  it("toggles sync on when the checkbox is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled={false} />);

    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);

    await waitFor(() => {
      expect(screen.getByText("Use schedule builder")).toBeInTheDocument();
    });
  });
});

describe("SyncSettingsContent — schedule disabled (upload datasets)", () => {
  it("disables the sync checkbox and hides schedule controls", () => {
    renderWithProviders(<SyncWrapper syncEnabled scheduleDisabled />);
    expect(screen.getByRole("checkbox")).toHaveAttribute("data-disabled");
    expect(screen.queryByText("Use schedule builder")).not.toBeInTheDocument();
    expect(document.querySelector(".dset-form__sync-content--schedule-disabled")).toBeInTheDocument();
  });

  it("does not enable scheduling when the checkbox is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled={false} scheduleDisabled />);

    await user.click(screen.getByRole("checkbox"));

    expect(screen.queryByText("Use schedule builder")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sync enabled — builder tab
// ---------------------------------------------------------------------------

describe("SyncSettingsContent — sync enabled, builder tab", () => {
  it("renders the schedule builder tab", () => {
    renderWithProviders(<SyncWrapper syncEnabled syncScheduleMode="builder" scheduleType="daily" />);
    expect(screen.getByText("Use schedule builder")).toBeInTheDocument();
  });

  it("renders Schedule frequency header", () => {
    renderWithProviders(<SyncWrapper syncEnabled />);
    expect(screen.getByText("Schedule frequency")).toBeInTheDocument();
  });

  it("renders all schedule type radio options", () => {
    renderWithProviders(<SyncWrapper syncEnabled />);
    expect(screen.getByText("Hourly")).toBeInTheDocument();
    expect(screen.getByText("Daily")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
  });

  it("shows the Time header for daily schedule", () => {
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="daily" />);
    expect(screen.getByText("Time")).toBeInTheDocument();
  });

  it("shows hour and minute fields for daily", () => {
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="daily" />);
    expect(screen.getByText("Hour (UTC)")).toBeInTheDocument();
    expect(screen.getByText("Minute of the hour (UTC)")).toBeInTheDocument();
  });

  it("shows Configure interval for hourly schedule", () => {
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="hourly" />);
    expect(screen.getByText("Configure interval")).toBeInTheDocument();
  });

  it("shows interval field for hourly", () => {
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="hourly" />);
    expect(screen.getByText("Interval (minutes)")).toBeInTheDocument();
  });

  it("shows day of week checkboxes for weekly schedule", () => {
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="weekly" />);
    expect(screen.getByText("Day of week")).toBeInTheDocument();
    expect(screen.getByText("Sun")).toBeInTheDocument();
    expect(screen.getByText("Mon")).toBeInTheDocument();
  });

  it("shows day of month field for monthly schedule", () => {
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="monthly" />);
    expect(screen.getByText("Day of month")).toBeInTheDocument();
  });

  it("switches from builder to cron tab on tab click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled syncScheduleMode="builder" />);

    const cronTab = screen.getByText("Use cron expression");
    await user.click(cronTab);

    await waitFor(() => {
      expect(screen.getByText("Cron expression")).toBeInTheDocument();
    });
  });

  it("switches schedule type to hourly on radio click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="daily" />);

    expect(screen.queryByText("Interval (minutes)")).not.toBeInTheDocument();
    await user.click(screen.getByText("Hourly"));

    await waitFor(() => {
      expect(screen.getByText("Interval (minutes)")).toBeInTheDocument();
    });
  });

  it("toggles a day-of-week checkbox on weekly schedule", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="weekly" dayOfWeek={[]} />);

    const monCheckbox = screen.getByRole("checkbox", { name: "Mon" });
    await user.click(monCheckbox);
    await waitFor(() => {
      expect(monCheckbox).toBeChecked();
    });

    await user.click(monCheckbox);
    await waitFor(() => {
      expect(monCheckbox).not.toBeChecked();
    });
  });

  it("toggles day-of-week when initial day_of_week is null (?? [] then deselect branch)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="weekly" dayOfWeek={null} />);

    const monCheckbox = screen.getByRole("checkbox", { name: "Mon" });
    await user.click(monCheckbox);
    await waitFor(() => {
      expect(monCheckbox).toBeChecked();
    });

    await user.click(monCheckbox);
    await waitFor(() => {
      expect(monCheckbox).not.toBeChecked();
    });
  });
});

// ---------------------------------------------------------------------------
// Sync enabled — cron tab
// ---------------------------------------------------------------------------

describe("SyncSettingsContent — sync enabled, cron tab", () => {
  it("renders the cron expression field", () => {
    renderWithProviders(<SyncWrapper syncEnabled syncScheduleMode="cron" />);
    expect(screen.getByText("Cron expression")).toBeInTheDocument();
  });

  it("switches back from cron to builder tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled syncScheduleMode="cron" />);

    const builderTab = screen.getByText("Use schedule builder");
    await user.click(builderTab);

    await waitFor(() => {
      expect(screen.getByText("Schedule frequency")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// rangeValidator — onBlur validation errors (runScheduleNumericRange branches)
// ---------------------------------------------------------------------------

describe("SyncSettingsContent — range validator blur errors", () => {
  it("shows 'Interval is required' when interval field is cleared and blurred (empty string branch, line 52)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="hourly" />);

    const input = screen.getByPlaceholderText("1");
    await user.clear(input);
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText(/Interval is required/i)).toBeInTheDocument();
    });
  });

  it("shows 'Interval must be a number' when non-numeric is entered and blurred (NaN branch, line 56)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="hourly" />);

    const input = screen.getByPlaceholderText("1");
    await user.clear(input);
    await user.type(input, "abc");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText(/Interval must be a number/i)).toBeInTheDocument();
    });
  });

  it("shows 'Interval must be between' when out-of-range value is entered and blurred (range branch, line 59)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SyncWrapper syncEnabled scheduleType="hourly" />);

    const input = screen.getByPlaceholderText("1");
    await user.clear(input);
    await user.type(input, "9999");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText(/Interval must be between/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// dayOfWeekError — rendered when field meta has errors (line 91)
// ---------------------------------------------------------------------------

describe("SyncSettingsContent — day-of-week field error", () => {
  it("shows day-of-week error after submit when no day is selected (line 91)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SyncWrapper
        syncEnabled
        scheduleType="weekly"
        dayOfWeek={[]}
        withSubmit
        withValidators
      />,
    );

    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByText(/Select at least one day/i)).toBeInTheDocument();
    });
  });
});
