import { screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderWithProviders } from "@test/render";

// ---------------------------------------------------------------------------
// Module mocks — declared before importing the component under test.
// ---------------------------------------------------------------------------

const mockUseLocation = vi.fn();
const mockUseParams = vi.fn();
const mockUseSearchParams = vi.fn();
const mockUseAppSelector = vi.fn();

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLocation: () => mockUseLocation(),
    useParams: () => mockUseParams(),
    useSearchParams: () => mockUseSearchParams(),
  };
});

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useGetAgentQuery: vi.fn(),
  useGetAgentTeamQuery: vi.fn(),
}));

vi.mock("@/routes/pages/agents/utils/agents-api-mapper", () => ({
  isTeamAgentId: (id: string) => id.startsWith("agr-"),
  mapAgentToFormValues: (agent: { id: string }) => ({
    configuration: "single",
    sourceId: agent.id,
  }),
  mapTeamToFormValues: (team: { id: string }) => ({
    configuration: "team",
    sourceId: team.id,
  }),
}));

vi.mock("@/store", () => ({
  useAppSelector: (...args: unknown[]) => mockUseAppSelector(...args),
}));

type StubFormProps = {
  isEdit?: boolean;
  agentId?: string;
  returnTo?: string;
  initialData?: { configuration?: string };
  initialIdentity?: { name?: string };
};

vi.mock("./form/agent-form", () => ({
  AgentForm: (props: StubFormProps) => (
    <div
      data-testid="agent-form"
      data-isedit={String(props.isEdit ?? false)}
      data-agentid={props.agentId ?? ""}
      data-returnto={props.returnTo ?? ""}
      data-config={props.initialData?.configuration ?? ""}
      data-name={props.initialIdentity?.name ?? ""}
    />
  ),
}));

import {
  useGetAgentQuery,
  useGetAgentTeamQuery,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import { AgentCreatePage } from "./agent-create-page";

const TEST_PROJECT_ID = "test-project";

function renderPage() {
  return renderWithProviders(<AgentCreatePage />, {
    preloadedState: {
      projectContext: {
        activeProject: { id: TEST_PROJECT_ID, name: "", role: null },
      },
    },
  });
}

// RTK Query hooks return a wide union; cast our minimal fixture through
// `unknown` so tests stay readable without an explicit `any`.
type QueryShape = { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown };
function queryResult(over: QueryShape = {}): ReturnType<typeof useGetAgentQuery> {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: undefined,
    ...over,
  } as unknown as ReturnType<typeof useGetAgentQuery>;
}

function teamQueryResult(over: QueryShape = {}): ReturnType<typeof useGetAgentTeamQuery> {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: undefined,
    ...over,
  } as unknown as ReturnType<typeof useGetAgentTeamQuery>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseLocation.mockReturnValue({ pathname: "/agents/create", state: null });
  mockUseParams.mockReturnValue({});
  mockUseSearchParams.mockReturnValue([new URLSearchParams(""), vi.fn()]);
  mockUseAppSelector.mockReturnValue("proj-test");
  vi.mocked(useGetAgentQuery).mockReturnValue(queryResult());
  vi.mocked(useGetAgentTeamQuery).mockReturnValue(teamQueryResult());
});

describe("AgentCreatePage", () => {
  it("[tag:agent-create] renders the form in create mode and skips the entity fetch", () => {
    renderPage();

    const form = screen.getByTestId("agent-form");
    expect(form).toHaveAttribute("data-isedit", "false");
    expect(form).toHaveAttribute("data-agentid", "");
    // Both queries are skipped in create mode (no preloaded configuration).
    expect(form).toHaveAttribute("data-config", "");
  });

  it("[tag:agent-create] seeds the form configuration from the ?configuration search param", () => {
    mockUseSearchParams.mockReturnValue([
      new URLSearchParams("configuration=team"),
      vi.fn(),
    ]);

    renderPage();

    expect(screen.getByTestId("agent-form")).toHaveAttribute(
      "data-config",
      "team",
    );
  });

  it("[tag:agent-create] ignores an unknown configuration search param", () => {
    mockUseSearchParams.mockReturnValue([
      new URLSearchParams("configuration=bogus"),
      vi.fn(),
    ]);

    renderPage();

    expect(screen.getByTestId("agent-form")).toHaveAttribute("data-config", "");
  });

  it("[tag:agent-create] passes location.state.returnTo through to the form", () => {
    mockUseLocation.mockReturnValue({
      pathname: "/agents/create",
      state: { returnTo: "/agents" },
    });

    renderPage();

    expect(screen.getByTestId("agent-form")).toHaveAttribute(
      "data-returnto",
      "/agents",
    );
  });

  it("[tag:agent-create][tag:edit] hydrates the form from a fetched single agent", () => {
    mockUseParams.mockReturnValue({ agentId: "ag-1" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/ag-1/edit",
      state: null,
    });
    vi.mocked(useGetAgentQuery).mockReturnValue(
      queryResult({
        data: { id: "ag-1", name: "Support agent", description: "d", labels: [] },
      }),
    );

    renderPage();

    const form = screen.getByTestId("agent-form");
    expect(form).toHaveAttribute("data-isedit", "true");
    expect(form).toHaveAttribute("data-agentid", "ag-1");
    expect(form).toHaveAttribute("data-config", "single");
    expect(form).toHaveAttribute("data-name", "Support agent");
  });

  it("[tag:agent-create][tag:edit] maps nullable single-agent identity fields to dialog defaults", () => {
    mockUseParams.mockReturnValue({ agentId: "ag-2" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/ag-2/edit",
      state: null,
    });
    vi.mocked(useGetAgentQuery).mockReturnValue(
      queryResult({
        data: { id: "ag-2", name: "Null-safe agent", description: null, labels: null },
      }),
    );

    renderPage();

    const form = screen.getByTestId("agent-form");
    expect(form).toHaveAttribute("data-isedit", "true");
    expect(form).toHaveAttribute("data-agentid", "ag-2");
    expect(form).toHaveAttribute("data-name", "Null-safe agent");
  });

  it("[tag:agent-create][tag:edit] routes `agr-` ids to the team query and maps team values", () => {
    mockUseParams.mockReturnValue({ agentId: "agr-1" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/agr-1/edit",
      state: null,
    });
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(
      teamQueryResult({
        data: { id: "agr-1", name: "Support pod", description: null, labels: null },
      }),
    );

    renderPage();

    const form = screen.getByTestId("agent-form");
    expect(form).toHaveAttribute("data-config", "team");
    expect(form).toHaveAttribute("data-name", "Support pod");
    expect(useGetAgentTeamQuery).toHaveBeenCalled();
  });

  it("[tag:agent-create][tag:edit] shows not-found when a single agent is missing", () => {
    mockUseParams.mockReturnValue({ agentId: "ag-1" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/ag-1/edit",
      state: null,
    });
    vi.mocked(useGetAgentQuery).mockReturnValue(
      queryResult({ data: undefined, isLoading: false }),
    );

    renderPage();

    expect(screen.queryByTestId("agent-form")).toBeNull();
    expect(screen.getByText("Agent not found.")).toBeInTheDocument();
  });

  it("[tag:agent-create][tag:edit] shows not-found when a team is missing", () => {
    mockUseParams.mockReturnValue({ agentId: "agr-1" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/agr-1/edit",
      state: null,
    });
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(
      teamQueryResult({ data: undefined, isLoading: false }),
    );

    renderPage();

    expect(screen.queryByTestId("agent-form")).toBeNull();
    expect(screen.getByText("Agent not found.")).toBeInTheDocument();
  });

  it("[tag:agent-create][tag:edit] shows not-found when API returns 404", () => {
    mockUseParams.mockReturnValue({ agentId: "ag-404" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/ag-404/edit",
      state: null,
    });
    vi.mocked(useGetAgentQuery).mockReturnValue(
      queryResult({ isError: true, error: { status: 404 } }),
    );

    renderPage();

    expect(screen.queryByTestId("agent-form")).toBeNull();
    expect(screen.getByText("Agent not found.")).toBeInTheDocument();
  });

  it("[tag:agent-create][tag:edit] shows a generic error when API returns non-404", () => {
    mockUseParams.mockReturnValue({ agentId: "ag-500" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/ag-500/edit",
      state: null,
    });
    vi.mocked(useGetAgentQuery).mockReturnValue(
      queryResult({ isError: true, error: { status: 500 } }),
    );

    renderPage();

    expect(screen.queryByTestId("agent-form")).toBeNull();
    expect(
      screen.getByText("Unable to load agent. Please try again."),
    ).toBeInTheDocument();
  });

  it("[tag:agent-create][tag:edit] shows a busy placeholder while the entity loads", () => {
    mockUseParams.mockReturnValue({ agentId: "ag-1" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/ag-1/edit",
      state: null,
    });
    vi.mocked(useGetAgentQuery).mockReturnValue(queryResult({ isLoading: true }));

    const { container } = renderPage();

    expect(screen.queryByTestId("agent-form")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("[tag:agent-create][tag:edit] shows a busy placeholder until project context exists", () => {
    mockUseParams.mockReturnValue({ agentId: "ag-1" });
    mockUseLocation.mockReturnValue({
      pathname: "/agents/ag-1/edit",
      state: null,
    });
    mockUseAppSelector.mockReturnValueOnce("");

    const { container } = renderPage();

    expect(screen.queryByTestId("agent-form")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
