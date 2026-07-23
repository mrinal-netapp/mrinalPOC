import { screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import { useForm } from "@tanstack/react-form";
import { Form } from "@/ui-lib/base-components/form";
import { buildDefaultValues } from "./dataset-form.utils";
import { validateDatasetFormOnSubmit } from "./dataset-form.validation";

// Mock VolumeBrowserDialog (used by the spec section's custom folder picker) so
// we can trigger onAdd without real API calls. Keeps the legacy testid so the
// existing assertions read clearly.
vi.mock("@/components/data-source/volume-browser/VolumeBrowserDialog", () => ({
  VolumeBrowserDialog: ({
    open,
    onOpenChange,
    onAdd,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdd?: (paths: string[]) => void;
  }) =>
    open ? (
      <div data-testid="folder-browser-dialog">
        <button onClick={() => { onAdd?.(["/new/folder1", "/new/folder2"]); onOpenChange(false); }}>
          Confirm add folders
        </button>
        <button onClick={() => onOpenChange(false)}>Cancel browse</button>
      </div>
    ) : null,
}));

import { SpecSection } from "./spec-section";

// ---------------------------------------------------------------------------
// Wrapper helpers
// ---------------------------------------------------------------------------

/**
 * Renders SpecSection inside a proper TanStack Form with an optional submit
 * trigger.
 *
 * SpecSection gates each scope behind an "Apply …" toggle. The toggles are
 * seeded from the form values (custom folder scope / any file filter / a SQL
 * query), so we seed those values here to render a scope expanded. Tests that
 * start collapsed flip the toggle via its `role="switch"` control.
 */
function SpecSectionWrapper({
  folderScope = "all" as "all" | "custom",
  paths = ["/"],
  withSubmit = false,
  fileScope = false,
  kind = "" as "" | "structured" | "unstructured",
}: {
  folderScope?: "all" | "custom";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paths?: string[] | null | any;
  withSubmit?: boolean;
  fileScope?: boolean;
  kind?: "" | "structured" | "unstructured";
}): ReactElement {
  const defaults = buildDefaultValues();
  defaults.spec.folder_scope = folderScope;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (defaults.spec as any).paths = paths;
  // Seeding a file filter makes isFileScopeActive() true, so the "Apply file
  // scope" toggle starts ON and the file-scope inputs render.
  if (fileScope) {
    defaults.kind = "unstructured";
    defaults.spec.file_types = ".pdf";
  } else if (kind) {
    defaults.kind = kind;
  }
  defaults.input_type = "data-source";
  defaults.data_source_id = "ds-test-123";

  const form = useForm({
    defaultValues: defaults,
    validators: { onSubmit: validateDatasetFormOnSubmit },
    onSubmit: async () => { },
  }) as unknown as Parameters<typeof SpecSection>[0]["form"];

  return (
    <Form form={form}>
      <SpecSection form={form} />
      {withSubmit && <button type="submit">Submit</button>}
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let roCleanup: () => void;

beforeEach(() => {
  roCleanup = mockResizeObserver().cleanup;
});
afterEach(() => {
  roCleanup?.();
});

describe("SpecSection", () => {
  it("renders folder scope section header", () => {
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/data"]} />);
    expect(screen.getByText("Folder scope")).toBeInTheDocument();
  });

  it("renders file scope section header", () => {
    renderWithProviders(<SpecSectionWrapper fileScope />);
    expect(screen.getByText("File scope")).toBeInTheDocument();
  });

  it("renders folder scope radio options (all and custom)", () => {
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/data"]} />);
    expect(screen.getByText("Use all folders")).toBeInTheDocument();
    expect(screen.getByText("Use custom selection")).toBeInTheDocument();
  });

  it("does NOT render the FolderPathsTable when folderScope is 'all'", () => {
    renderWithProviders(<SpecSectionWrapper folderScope="all" />);
    expect(screen.queryByText("Custom folder selection")).not.toBeInTheDocument();
  });

  it("renders the FolderPathsTable when folderScope is 'custom'", () => {
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/data"]} />);
    expect(screen.getByText("Custom folder selection")).toBeInTheDocument();
  });

  it("displays a path row in the FolderPathsTable", () => {
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/data/volume1"]} />);
    expect(screen.getByText("/data/volume1")).toBeInTheDocument();
  });

  it("renders the 'Add Custom Folders' button when scope is custom", () => {
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={[]} />);
    expect(screen.getByText("Add Custom Folders")).toBeInTheDocument();
  });

  it("switches to custom scope on radio click and shows FolderPathsTable", async () => {
    const user = userEvent.setup();
    // Start with the folder scope toggle ON (custom seeds it) but on "all", so
    // the radios render without the custom-selection table.
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/data"]} />);

    // Switch to "all" first so the table is hidden, then back to custom.
    await user.click(screen.getByText("Use all folders"));
    await waitFor(() => {
      expect(screen.queryByText("Custom folder selection")).not.toBeInTheDocument();
    });

    await user.click(screen.getByText("Use custom selection"));
    await waitFor(() => {
      expect(screen.getByText("Custom folder selection")).toBeInTheDocument();
    });
  });

  it("renders file scope inputs (Types, Last modified, Size limit)", () => {
    renderWithProviders(<SpecSectionWrapper fileScope />);
    expect(screen.getByText("Types")).toBeInTheDocument();
    expect(screen.getByText("Last modified")).toBeInTheDocument();
    expect(screen.getByText(/Size limit/)).toBeInTheDocument();
  });

  it("renders Exclude patterns field", () => {
    renderWithProviders(<SpecSectionWrapper fileScope />);
    expect(screen.getByText("Exclude patterns")).toBeInTheDocument();
  });

  it("disables file scope toggle when dataset kind is structured", () => {
    renderWithProviders(<SpecSectionWrapper kind="structured" />);
    expect(screen.getByRole("switch", { name: "Apply file scope" })).toHaveAttribute("data-disabled", "");
    expect(screen.getByText("Apply file scope")).toHaveClass("typography--disabled");
    expect(screen.getByText("Apply file scope").closest(".dset-form__scope-toggle-row--disabled")).toBeTruthy();
  });
});

describe("FolderPathsTable — null paths fallback", () => {
  it("renders empty table without crashing when spec.paths is null (rawPaths ?? [] null branch)", () => {
    // Covers the `?? []` fallback in FolderPathsTable when rawPaths is null/undefined
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={null} />);
    expect(screen.getByText("Custom folder selection")).toBeInTheDocument();
    expect(screen.getByText("Add Custom Folders")).toBeInTheDocument();
  });
});

describe("FolderPathsTable — remove interaction", () => {
  it("calls form.setFieldValue to remove a path when Remove is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/vol1", "/vol2"]} />);

    expect(screen.getByText("/vol1")).toBeInTheDocument();

    const menuButton = screen.getByRole("button", { name: "Actions for /vol1" });
    await user.click(menuButton);

    const removeItem = await screen.findByRole("menuitem", { name: "Remove" });
    await user.click(removeItem);

    await waitFor(() => {
      expect(screen.queryByText("/vol1")).not.toBeInTheDocument();
    });
  });
});

describe("FolderPathsTable — add folders dialog", () => {
  it("clicking 'Add Custom Folders' opens the VolumeBrowserDialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/data"]} />);

    expect(screen.queryByTestId("folder-browser-dialog")).not.toBeInTheDocument();

    await user.click(screen.getByText("Add Custom Folders"));

    expect(screen.getByTestId("folder-browser-dialog")).toBeInTheDocument();
  });

  it("confirming dialog replaces scope with the latest selected path (handleAddFolders)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/existing"]} />);

    await user.click(screen.getByText("Add Custom Folders"));
    await user.click(screen.getByText("Confirm add folders"));

    // Dialog should be closed
    await waitFor(() => {
      expect(screen.queryByTestId("folder-browser-dialog")).not.toBeInTheDocument();
    });

    // Latest pick replaces the previous scope entry
    await waitFor(() => {
      expect(screen.queryByText("/existing")).not.toBeInTheDocument();
      expect(screen.getByText("/new/folder2")).toBeInTheDocument();
    });
    expect(screen.queryByText("/new/folder1")).not.toBeInTheDocument();
  });

  it("adds a single folder when current paths are null (covers ?? [] fallback in handleAddFolders)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={null} />);

    await user.click(screen.getByText("Add Custom Folders"));
    await user.click(screen.getByText("Confirm add folders"));

    await waitFor(() => {
      expect(screen.queryByTestId("folder-browser-dialog")).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("/new/folder2")).toBeInTheDocument();
    });
    expect(screen.queryByText("/new/folder1")).not.toBeInTheDocument();
  });

  it("canceling the dialog does not add paths", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/data"]} />);

    await user.click(screen.getByText("Add Custom Folders"));
    await user.click(screen.getByText("Cancel browse"));

    await waitFor(() => {
      expect(screen.queryByTestId("folder-browser-dialog")).not.toBeInTheDocument();
    });

    expect(screen.getByText("/data")).toBeInTheDocument();
    expect(screen.queryByText("/new/folder1")).not.toBeInTheDocument();
  });
});

describe("FolderPathsFieldError", () => {
  it("shows no error message when spec.paths is valid", () => {
    renderWithProviders(<SpecSectionWrapper folderScope="custom" paths={["/data"]} />);
    expect(screen.queryByText(/Add at least one folder path/i)).not.toBeInTheDocument();
  });

  it("shows spec.paths error after form submit when paths are empty", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SpecSectionWrapper folderScope="custom" paths={[]} withSubmit />,
    );

    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByText(/Add at least one folder path/i)).toBeInTheDocument();
    });
  });
});
