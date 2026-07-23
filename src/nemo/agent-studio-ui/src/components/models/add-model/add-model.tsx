import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowsSort,
  IconBox,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconCircleCheck,
  IconDots,
  IconSearch,
  IconServer,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState, type ReactElement } from "react";
import { useBlocker, useNavigate } from "react-router";

import { AddEntityForm } from "@/components/common/add-entity-form/add-entity-form";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { Button } from "@/ui-lib/base-components/button/button";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { Input } from "@/ui-lib/base-components/input/input";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import type { SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types";
import { TabContent, TabGroup } from "@/ui-lib/base-components/tab/tab-group";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui-lib/base-components/baseTableMcpBxp/table/table";
import { FloatingLayerContext } from "@/ui-lib/lib/floating-layer-context";
import { cn } from "@/ui-lib/lib/utils";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { ROUTES } from "@/routes/routes.consts";
import { useAppDispatch, useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  modelsApi,
  useCreateModelMutation,
  useListAvailableModelsQuery,
} from "@/routes/pages/models/models.api";
import { EditModelModal } from "@/components/models/edit-model/edit-model-modal";
import type { EditModelConfig } from "@/components/models/edit-model/edit-model-modal.types";

import {
  PROVIDER_CATALOG,
  PROVIDER_TABS,
} from "./add-model.consts";
import type {
  ModelCatalogItem,
  ModelProvider,
  ProviderSortColumn,
  ProviderSortState,
} from "./add-model.types";
import {
  buildModelDropdownData,
  buildSelectedModelCardDetails,
  configToModelLimits,
  providerColumnAriaSort,
  resolveModelRegistrationName,
  sortProviderRows,
} from "./add-model.utils";
import { ModelProviderConfigureModal } from "./model-provider-configure-modal";
import type { ConfigureModalFlow } from "./model-provider-configure-modal.types";

import "./add-model.scss";

/** Providers table page size — 10 rows per page, then paginate. */
const PROVIDER_PAGE_SIZE = 10;

function SelectedModelCard({
  model,
  config,
  registrationName,
  onModify,
  onRemove,
}: {
  model: ModelCatalogItem;
  config?: EditModelConfig;
  registrationName: string;
  onModify: () => void;
  onRemove: () => void;
}): ReactElement {
  const details = buildSelectedModelCardDetails(model, config);
  return (
    <Card className="add-model__card">
      <CardHeader
        icon={<IconBox size={24} stroke={1.5} />}
        title={registrationName}
        hasSeparator
        actions={[
          <Button key="modify" variant="flat" size="small" label="Modify" onClick={onModify} />,
          <DropdownMenu key="more">
            <DropdownMenuTrigger
              render={
                <Button
                  variant="icon"
                  size="small"
                  icon={<IconDots size={16} stroke={1.5} />}
                  aria-label={`More actions for ${registrationName}`}
                />
              }
            />
            <DropdownMenuContent side="bottom" align="end">
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <IconTrash size={16} stroke={1.5} />
                <Typography Component="span" fontSize="fs14" boldness="regular">
                  Remove
                </Typography>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>,
        ]}
      />
      <CardContent className="add-model__card-body">
        <div className="add-model__detail-grid">
          {details.map(({ label, value }) => (
            <div key={label} className="add-model__detail-row">
              <Typography Component="span" fontSize="fs14">
                {label}
                :
              </Typography>
              <Typography
                Component="span"
                fontSize="fs14"
                className={cn(
                  "add-model__detail-value",
                  !value && "add-model__detail-value--empty",
                )}
              >
                {value || "\u00A0"}
              </Typography>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

type ProviderColumnSortButtonProps = {
  column: ProviderSortColumn;
  label: string;
  sort: ProviderSortState;
  onSort: (column: ProviderSortColumn) => void;
};

function ProviderColumnSortButton({ column, label, sort, onSort }: ProviderColumnSortButtonProps): ReactElement {
  const isActiveColumn = sort?.column === column;
  const sortIcon = (
    <span className="add-model__th-sort" aria-hidden>
      {sort?.column === column && sort.direction === "asc" ? (
        <IconChevronUp size={14} stroke={1.5} />
      ) : sort?.column === column && sort.direction === "desc" ? (
        <IconChevronDown size={14} stroke={1.5} />
      ) : (
        <IconArrowsSort size={14} stroke={1.25} />
      )}
    </span>
  );
  return (
    <Button
      type="button"
      variant="flat"
      size="medium"
      label={label}
      icon={sortIcon}
      className={cn("add-model__th-btn", isActiveColumn && "add-model__th-btn--active")}
      aria-label={`Sort by ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onSort(column);
      }}
    />
  );
}

type ProxyToggleProps = {
  open: boolean;
  onToggle: () => void;
  concurrentRequests: string;
  bufferSize: string;
  onConcurrentRequestsChange: (value: string) => void;
  onBufferSizeChange: (value: string) => void;
};

function ProxyToggle({
  open,
  onToggle,
  concurrentRequests,
  bufferSize,
  onConcurrentRequestsChange,
  onBufferSizeChange,
}: ProxyToggleProps): ReactElement {
  return (
    <>
      <Button
        type="button"
        variant="flat"
        size="medium"
        label="Proxy configuration"
        icon={
          <IconChevronDown
            size={16}
            className={cn("add-model__proxy-chevron", open && "add-model__proxy-chevron--open")}
            aria-hidden
          />
        }
        className={cn("add-model__proxy-toggle", open && "add-model__proxy-toggle--open")}
        aria-expanded={open}
        onClick={onToggle}
      />
      {open ? (
        <div className="add-model__proxy-body">
          <div className="add-model__proxy-fields">
            <Input
              type="number"
              label="Concurrent requests"
              placeholder="Enter concurrent requests"
              value={concurrentRequests}
              onChange={(e) => onConcurrentRequestsChange(e.target.value)}
            />
            <Input
              type="number"
              label="Buffer size"
              placeholder="Enter buffer size"
              value={bufferSize}
              onChange={(e) => onBufferSizeChange(e.target.value)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Map backend model-create failures to clearer copy for the Add-model flow. */
function formatCreateModelError(
  err: unknown,
  registrationName: string,
  existingModelId?: string,
): string {
  const raw = extractErrorMessage(err);
  if (/already exists/i.test(raw)) {
    const locateHint = existingModelId
      ? `Open Models → Models tab (search "${registrationName}" or open details).`
      : `Open Models → Models tab and search "${registrationName}" (it may be on page 2 if many embeddings are listed).`;
    return `A model named "${registrationName}" is already registered in this project. ${locateHint}`;
  }
  return raw;
}

/** Best-effort human-readable message from an RTK Query error. */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      data?: { error?: unknown; errors?: Array<{ msg?: unknown }> } | string;
    };
    if (typeof e.data === "string" && e.data.trim()) return e.data;
    if (e.data && typeof e.data === "object") {
      if (typeof e.data.error === "string" && e.data.error.trim()) return e.data.error;
      const firstMsg = e.data.errors?.[0]?.msg;
      if (typeof firstMsg === "string" && firstMsg.trim()) return firstMsg;
    }
  }
  return "Request failed. Please try again.";
}

function parsePositiveInt(value: unknown): number | undefined {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function AddModel(): ReactElement {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [createModel] = useCreateModelMutation();
  const [providerTab, setProviderTab] = useState("providers");
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyConcurrentRequests, setProxyConcurrentRequests] = useState("");
  const [proxyBufferSize, setProxyBufferSize] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [configureModalOpen, setConfigureModalOpen] = useState(false);
  const [configureModalFlow, setConfigureModalFlow] =
    useState<ConfigureModalFlow>("providers");
  const [isProviderAuthenticated, setIsProviderAuthenticated] = useState(false);
  /*
   * Credential resolved by the Configure modal (existing pick or freshly
   * created). Attached to each model on the final "Add" submission.
   */
  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedProviderModels, setSelectedProviderModels] = useState<(string | number)[]>([]);
  const [editModelModalOpen, setEditModelModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelCatalogItem | null>(null);
  // Per-model budget/rate-limit + pricing, keyed by model card key. Populated
  // when the user saves the "Modify" (EditModel) modal; merged into the
  // POST /models body on submit so the limits reach Bifrost.
  const [modelConfigs, setModelConfigs] = useState<Record<string, EditModelConfig>>({});
  const [providerSort, setProviderSort] = useState<ProviderSortState>(null);
  // Zero-based page index for the providers table (PROVIDER_PAGE_SIZE rows/page).
  const [providerPage, setProviderPage] = useState(0);
  // Free-text provider filter; the toolbar search icon toggles the input.
  const [providerSearch, setProviderSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  /*
   * Provider *types* available to connect to. Sourced from the local
   * PROVIDER_CATALOG (config-service provider keys + display metadata).
   * TODO(backend): swap for a real provider-catalog query once the model
   * service exposes one — at which point restore the loading + error
   * branches in the render below (Spinner + Retry button) keyed off the
   * hook's `isLoading` / `isError` flags.
   */
  const providerRows = useMemo<ModelProvider[]>(() => [...PROVIDER_CATALOG], []);

  // Case-insensitive filter across the name / capabilities / data-residency
  // columns. Applied before sorting + pagination so the count and pages track
  // the filtered result set.
  const normalizedProviderSearch = providerSearch.trim().toLowerCase();
  const filteredProviderRows = useMemo(() => {
    if (!normalizedProviderSearch) return providerRows;
    return providerRows.filter((r) =>
      `${r.name} ${r.capabilities} ${r.data_residency}`
        .toLowerCase()
        .includes(normalizedProviderSearch),
    );
  }, [providerRows, normalizedProviderSearch]);

  const sortedProviderRows = useMemo(
    () => sortProviderRows(filteredProviderRows, providerSort),
    [filteredProviderRows, providerSort],
  );
  const totalProviderCount = filteredProviderRows.length;
  const pageCount = Math.max(1, Math.ceil(totalProviderCount / PROVIDER_PAGE_SIZE));
  // Clamp so a stale page index (e.g. after the list shrinks) never renders an
  // empty page or unreachable arrows.
  const currentPage = Math.min(providerPage, pageCount - 1);
  const pageStartIndex = currentPage * PROVIDER_PAGE_SIZE;
  const paginatedProviderRows = useMemo(
    () => sortedProviderRows.slice(pageStartIndex, pageStartIndex + PROVIDER_PAGE_SIZE),
    [sortedProviderRows, pageStartIndex],
  );
  const pageStart = totalProviderCount === 0 ? 0 : pageStartIndex + 1;
  const pageEnd = Math.min(pageStartIndex + PROVIDER_PAGE_SIZE, totalProviderCount);

  const effectiveSelectedProviderId = useMemo(() => {
    if (providerRows.length === 0) {
      return null;
    }
    if (selectedProviderId != null && providerRows.some((r) => r.provider_id === selectedProviderId)) {
      return selectedProviderId;
    }
    const preferred = providerRows.find((r) => r.provider_id === "openai");
    return preferred?.provider_id ?? providerRows[0]?.provider_id ?? null;
  }, [providerRows, selectedProviderId]);

  /*
   * Switching the selected provider invalidates the prior connection: the
   * saved credential belongs to a different provider, so reset auth + model
   * selection to force a fresh Configure step.
   */
  function handleSelectProvider(id: string): void {
    if (id === selectedProviderId) return;
    setSelectedProviderId(id);
    setIsProviderAuthenticated(false);
    setSelectedCredentialId(null);
    setSelectedProviderModels([]);
  }

  function handleProviderSearchChange(value: string): void {
    // Filtering changes the result set, so restart from the first page.
    setProviderSearch(value);
    setProviderPage(0);
  }

  function toggleProviderSearch(): void {
    setSearchOpen((open) => {
      if (open) {
        // Collapsing the search clears the query so the full list returns.
        setProviderSearch("");
        setProviderPage(0);
      }
      return !open;
    });
  }

  function handleProviderColumnSort(column: ProviderSortColumn): void {
    // Re-sorting reorders the whole list, so jump back to the first page.
    setProviderPage(0);
    setProviderSort((prev) => {
      if (prev?.column !== column) {
        return { column, direction: "asc" };
      }
      if (prev.direction === "asc") {
        return { column, direction: "desc" };
      }
      return null;
    });
  }

  const selectedProviderName = useMemo(() => {
    if (effectiveSelectedProviderId == null) return null;
    return providerRows.find((r) => r.provider_id === effectiveSelectedProviderId)?.name ?? null;
  }, [effectiveSelectedProviderId, providerRows]);

  const openProvidersConfigureModal = (): void => {
    setConfigureModalFlow("providers");
    setConfigureModalOpen(true);
  };

  /*
   * Live upstream catalog for the configured provider. Fetched only once the
   * provider connection is authenticated and a credential is attached; the
   * backend resolves the credential secret server-side to query the provider.
   */
  const {
    data: availableModels,
    isFetching: isLoadingAvailableModels,
    isError: isAvailableModelsError,
  } = useListAvailableModelsQuery(
    {
      projectId: projectId ?? "",
      provider: effectiveSelectedProviderId ?? "",
      credentialId: selectedCredentialId ?? undefined,
    },
    {
      skip:
        !projectId ||
        !effectiveSelectedProviderId ||
        !selectedCredentialId ||
        !isProviderAuthenticated,
    },
  );

  const providerCatalog = useMemo<ModelCatalogItem[]>(
    () =>
      (availableModels ?? []).map((m) => ({
        key: m.id,
        value: m.id,
        label: m.name,
        kind: m.type === "embedding" ? "embedding" : "llm",
      })),
    [availableModels],
  );

  /*
   * Connection status reflects the real provider round-trip rather than an
   * optimistic flag: `list-available` is skipped until a credential is
   * attached, fetches while we contact the provider, errors when the
   * credentials/endpoint are rejected, and returns the catalog on success
   * (which also fills the model dropdown). This is the same upstream call the
   * dedicated `/validate` makes, but with the longer timeout the dropdown uses.
   */
  const connectionStatus: "unconfigured" | "checking" | "failed" | "connected" =
    !isProviderAuthenticated || !selectedCredentialId
      ? "unconfigured"
      : isLoadingAvailableModels
        ? "checking"
        : isAvailableModelsError
          ? "failed"
          : "connected";

  const providerDropdownData = useMemo(() => buildModelDropdownData(providerCatalog), [providerCatalog]);
  const visibleProviderModelGroups = useMemo(
    () => (isProviderAuthenticated ? providerDropdownData.groups : []),
    [isProviderAuthenticated, providerDropdownData.groups],
  );

  const selectedProviderModelCards = useMemo(() => {
    if (!Array.isArray(selectedProviderModels) || selectedProviderModels.length === 0) return [];
    const seen = new Set<string | number>();
    return selectedProviderModels
      .map((v) => providerCatalog.find((m) => Object.is(m.value, v)))
      .filter((m): m is ModelCatalogItem => {
        if (m == null) return false;
        if (seen.has(m.value)) return false;
        seen.add(m.value);
        return true;
      });
  }, [providerCatalog, selectedProviderModels]);

  const goBack = (): void => {
    navigate(`/${ROUTES.MODELS}`);
  };

  /*
   * Final submission: register each selected provider model against the
   * configured credential via `POST /models`. Runs sequentially so a 409
   * (duplicate name) on one model doesn't abort the rest, then surfaces a
   * per-model failure summary. `submitting` stays true through the success
   * redirect so the prompt-on-leave blocker doesn't fire against itself.
   */
  const handleAddModels = async (): Promise<void> => {
    if (!projectId) {
      toast.error("No active project selected.");
      return;
    }
    if (!effectiveSelectedProviderId) {
      toast.error("Select a provider to continue.");
      return;
    }
    if (!isProviderAuthenticated || !selectedCredentialId) {
      toast.error("Configure the provider connection before adding models.");
      return;
    }
    if (selectedProviderModelCards.length === 0) {
      toast.error("Select at least one model to add.");
      return;
    }

    setSubmitting(true);
    const failures: string[] = [];
    const concurrentRequests = parsePositiveInt(proxyConcurrentRequests);
    const bufferSize = parsePositiveInt(proxyBufferSize);
    const seenRegistrationNames = new Set<string>();
    for (const model of selectedProviderModelCards) {
      const config = modelConfigs[model.key];
      const registrationName = resolveModelRegistrationName(model, config);
      if (!registrationName) {
        failures.push(`${model.label}: Model name is required.`);
        continue;
      }
      if (seenRegistrationNames.has(registrationName)) {
        failures.push(
          `${registrationName}: Selected more than once — remove the duplicate or use Modify to give each a unique name.`,
        );
        continue;
      }
      seenRegistrationNames.add(registrationName);
      try {
        await createModel({
          projectId,
          body: {
            name: registrationName,
            provider: effectiveSelectedProviderId,
            credentialId: selectedCredentialId,
            providerModelId: String(model.value),
            modelType: model.kind === "embedding" ? "embedding" : "llm",
            ...configToModelLimits(config),
            ...(concurrentRequests != null ? { concurrentRequests } : {}),
            ...(bufferSize != null ? { bufferSize } : {}),
          },
        }).unwrap();
      } catch (err) {
        let existingModelId: string | undefined;
        if (/already exists/i.test(extractErrorMessage(err))) {
          try {
            const listed = await dispatch(
              modelsApi.endpoints.listModels.initiate({ projectId }, { forceRefetch: true }),
            ).unwrap();
            existingModelId = listed.data?.find((m) => m.name === registrationName)?.model_id;
          } catch {
            // Best-effort lookup only — fall back to the generic duplicate copy.
          }
        }
        failures.push(`${registrationName}: ${formatCreateModelError(err, registrationName, existingModelId)}`);
      }
    }

    if (failures.length > 0) {
      setSubmitting(false);
      toast.error(`Some models could not be added — ${failures.join("; ")}`);
      return;
    }

    toast.success(
      selectedProviderModelCards.length === 1
        ? "Model added."
        : `${selectedProviderModelCards.length} models added.`,
    );
    navigate(`/${ROUTES.MODELS}`);
  };

  /*
   * RT-003 — prompt-on-leave. The Add-model flow accumulates state across
   * multiple steps (pick a provider, configure credentials, pick models),
   * so unsaved progress is anything beyond the initial "empty" state.
   *
   * `useBlocker` intercepts every router-driven navigation away from this
   * route — sidebar links, browser Back, AND the in-page X / Cancel /
   * Escape (because `goBack` itself calls `navigate(...)`). The blocker
   * pauses the navigation and surfaces ConfirmDialog; the user then
   * Stays (resets the blocker) or Discards (proceeds).
   *
   * If we ever wire a real submission state (e.g. an in-flight POST to
   * register the selected models), pass `&& !isSubmitting` here so the
   * post-submit redirect doesn't trip the discard prompt against itself.
   */
  const isDirty =
    (selectedProviderId !== null ||
      isProviderAuthenticated ||
      selectedProviderModels.length > 0) &&
    !submitting;
  const blocker = useBlocker(isDirty);
  const isBlocked = blocker.state === "blocked";

  function handleEditModelModalOpenChange(nextOpen: boolean): void {
    setEditModelModalOpen(nextOpen);
    if (!nextOpen) {
      setEditingModel(null);
    }
  }

  function openEditModelModal(model: ModelCatalogItem): void {
    setEditingModel(model);
    setEditModelModalOpen(true);
  }

  /*
   * Drop a model from the selection: remove it from the picker value and its
   * per-model config (keyed by card key) so it no longer appears as a card and
   * isn't submitted.
   */
  function removeSelectedModel(model: ModelCatalogItem): void {
    setSelectedProviderModels((prev) => prev.filter((v) => !Object.is(v, model.value)));
    setModelConfigs((prev) => {
      if (!(model.key in prev)) return prev;
      const next = { ...prev };
      delete next[model.key];
      return next;
    });
  }

  return (
    <>
      {/*
       * AddEntityForm owns the page chrome: fixed header bar with "Add model"
       * title and close X, the scrollable body wrapped in a Card, and the
       * frozen Add / Cancel footer. We pass the multi-step provider flow as
       * a single section node. FloatingLayerContext keeps SelectDropdown
       * popovers (model picker, sort menu) above the dialog z-index.
       */}
      <AddEntityForm
        open
        title="Add model"
        entityName="Model"
        entityDescription="Add LLM and embedding models for your agents and knowledge bases."
        onAdd={() => {
          void handleAddModels();
        }}
        onCancel={goBack}
        sections={[
          <FloatingLayerContext.Provider key="provider-details" value={{ zIndex: 120 }}>
            <section className="add-model__section">
            <div className="add-model__section-heading">
              <Typography Component="h3" fontSize="fs14" boldness="semibold">
                Provider details
              </Typography>
              <Typography Component="p" fontSize="fs14">
                Select how you want to connect and manage AI models.
              </Typography>
            </div>

            <TabGroup
              tabs={PROVIDER_TABS}
              activeTabId={providerTab}
              onTabChange={setProviderTab}
              ariaLabel="Provider type"
              className="add-model__tabs"
            >
              <TabContent tabId="providers" className="add-model__tab-panel add-model__tab-panel--providers">
                <div className="add-model__providers-wrap">
                  <div className="add-model__providers-toolbar">
                    <Typography Component="p" fontSize="fs16" boldness="semibold">
                      Providers ({totalProviderCount})
                    </Typography>
                    <div className="add-model__providers-search">
                      {searchOpen ? (
                        <Input
                          type="search"
                          className="add-model__providers-search-input"
                          placeholder="Search providers"
                          aria-label="Search providers"
                          value={providerSearch}
                          onChange={(e) => handleProviderSearchChange(e.target.value)}
                          autoFocus
                        />
                      ) : null}
                      <Button
                        variant="icon"
                        size="medium"
                        icon={<IconSearch size={18} stroke={1.5} />}
                        aria-label={searchOpen ? "Close provider search" : "Search providers"}
                        aria-expanded={searchOpen}
                        onClick={toggleProviderSearch}
                      />
                    </div>
                  </div>

                  {providerRows.length === 0 ? (
                    <div className="add-model__providers-state">
                      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                        No providers are available yet.
                      </Typography>
                    </div>
                  ) : filteredProviderRows.length === 0 ? (
                    <div className="add-model__providers-state">
                      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                        No providers match &ldquo;{providerSearch.trim()}&rdquo;.
                      </Typography>
                    </div>
                  ) : (
                    <>
                      <Table className="add-model__providers-table" aria-label="AI model providers">
                        <TableHeader>
                          <TableRow className="add-model__table-head-row">
                            <TableHead
                              scope="col"
                              className="add-model__table-head-cell add-model__table-cell add-model__table-cell--radio"
                            >
                              <span className="add-model__sr-only">Selection</span>
                            </TableHead>
                            <TableHead
                              scope="col"
                              aria-sort={providerColumnAriaSort("name", providerSort)}
                              className="add-model__table-head-cell add-model__table-cell add-model__table-cell--name"
                            >
                              <ProviderColumnSortButton
                                column="name"
                                label="Name"
                                sort={providerSort}
                                onSort={handleProviderColumnSort}
                              />
                            </TableHead>
                            <TableHead
                              scope="col"
                              aria-sort={providerColumnAriaSort("capabilities", providerSort)}
                              className="add-model__table-head-cell add-model__table-cell add-model__table-cell--caps"
                            >
                              <ProviderColumnSortButton
                                column="capabilities"
                                label="Capabilities"
                                sort={providerSort}
                                onSort={handleProviderColumnSort}
                              />
                            </TableHead>
                            <TableHead
                              scope="col"
                              aria-sort={providerColumnAriaSort("data_residency", providerSort)}
                              className="add-model__table-head-cell add-model__table-cell add-model__table-cell--residency"
                            >
                              <ProviderColumnSortButton
                                column="data_residency"
                                label="Data residency"
                                sort={providerSort}
                                onSort={handleProviderColumnSort}
                              />
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {paginatedProviderRows.map((row) => {
                            const selected = effectiveSelectedProviderId === row.provider_id;
                            return (
                              <TableRow
                                key={row.provider_id}
                                className={cn(
                                  "add-model__table-row",
                                  selected && "add-model__table-row--selected",
                                )}
                                data-state={selected ? "selected" : undefined}
                                aria-selected={selected}
                tabIndex={0}
                onClick={() => {
                  handleSelectProvider(row.provider_id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleSelectProvider(row.provider_id);
                  }
                }}
              >
                                <TableCell className="add-model__table-cell add-model__table-cell--radio">
                                  <input
                                    type="radio"
                                    name="add-model-provider"
                                    className="add-model__sr-only"
                    checked={selected}
                    onChange={() => {
                      handleSelectProvider(row.provider_id);
                    }}
                    tabIndex={-1}
                                    aria-label={`Select provider ${row.name}`}
                                  />
                                  <span className="add-model__radio" aria-hidden>
                                    {selected ? (
                                      <span className="add-model__radio-dot" />
                                    ) : (
                                      <IconCircle
                                        size={22}
                                        stroke={1.25}
                                        className="add-model__radio-ring"
                                      />
                                    )}
                                  </span>
                                </TableCell>
                                <TableCell className="add-model__table-cell add-model__table-cell--name">
                                  <Typography Component="span" fontSize="fs14">
                                    {row.name}
                                  </Typography>
                                </TableCell>
                                <TableCell className="add-model__table-cell add-model__table-cell--caps">
                                  <Typography Component="span" fontSize="fs14">
                                    {row.capabilities}
                                  </Typography>
                                </TableCell>
                                <TableCell className="add-model__table-cell add-model__table-cell--residency">
                                  <Typography Component="span" fontSize="fs14">
                                    {row.data_residency}
                                  </Typography>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>

                      <div className="add-model__pagination">
                        <Typography Component="span" fontSize="fs14" boldness="semibold">
                          {pageStart} - {pageEnd} of {totalProviderCount}
                        </Typography>
                        <div className="add-model__pagination-arrows">
                          <Button
                            variant="icon"
                            size="small"
                            icon={<IconChevronLeft size={20} stroke={1.5} />}
                            isDisabled={currentPage === 0}
                            onClick={() => setProviderPage((p) => Math.max(0, p - 1))}
                            aria-label="Previous page"
                          />
                          <Button
                            variant="icon"
                            size="small"
                            icon={<IconChevronRight size={20} stroke={1.5} />}
                            isDisabled={currentPage >= pageCount - 1}
                            onClick={() => setProviderPage((p) => Math.min(pageCount - 1, p + 1))}
                            aria-label="Next page"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <ProxyToggle
                  open={proxyOpen}
                  onToggle={() => setProxyOpen((o) => !o)}
                  concurrentRequests={proxyConcurrentRequests}
                  bufferSize={proxyBufferSize}
                  onConcurrentRequestsChange={setProxyConcurrentRequests}
                  onBufferSizeChange={setProxyBufferSize}
                />

                <div className="add-model__rule-conditions-group">
                  <hr className="add-model__divider" />
                  <div className="add-model__rule-conditions">
                    <div className="add-model__section-heading add-model__section-heading--rule">
                      <Typography Component="h3" fontSize="fs14" boldness="semibold">
                        Connection details
                      </Typography>
                      <Typography Component="p" fontSize="fs14">
                        Configure model provider connection details.
                      </Typography>
                    </div>

                    <Card className="add-model__card">
                      <CardHeader
                        icon={<IconServer size={24} stroke={1.5} />}
                        title="Connection details"
                        hasSeparator
                        actions={[
                          <Button
                            key="configure"
                            variant="flat"
                            size="small"
                            label="Configure"
                            onClick={openProvidersConfigureModal}
                          />,
                        ]}
                      />
                      <CardContent className="add-model__card-body">
                      <div className="add-model__props add-model__props--single">
                        <Typography Component="span" fontSize="fs14">
                          Connection status
                        </Typography>
                        {connectionStatus === "connected" ? (
                          <div className="add-model__success-row">
                            <IconCircleCheck
                              size={16}
                              className="add-model__success-icon"
                              aria-hidden
                            />
                            <Typography Component="span" fontSize="fs14">
                              Successful
                            </Typography>
                          </div>
                        ) : connectionStatus === "checking" ? (
                          <div className="add-model__success-row">
                            <Spinner size="inline" />
                            <Typography Component="span" fontSize="fs14">
                              Checking connection…
                            </Typography>
                          </div>
                        ) : connectionStatus === "failed" ? (
                          <div className="add-model__warn-row">
                            <IconAlertCircle
                              size={16}
                              className="add-model__warn-icon"
                              aria-hidden
                            />
                            <Typography
                              Component="span"
                              fontSize="fs14"
                              color="var(--notification-error)"
                            >
                              Connection failed — check the credentials
                            </Typography>
                          </div>
                        ) : (
                          <div className="add-model__warn-row">
                            <IconAlertTriangle
                              size={16}
                              className="add-model__warn-icon"
                              aria-hidden
                            />
                            <Typography Component="span" fontSize="fs14">
                              Not configured
                            </Typography>
                          </div>
                        )}
                      </div>
                      </CardContent>
                    </Card>
                  </div>
                </div>

                <div className="add-model__rule-conditions-group">
                  <hr className="add-model__divider" />
                  <div className="add-model__rule-conditions">
                    <div className="add-model__model-config-intro">
                      <div className="add-model__section-heading">
                        <Typography Component="h3" fontSize="fs14" boldness="semibold">
                          Model configuration
                        </Typography>
                        <Typography Component="p" fontSize="fs14">
                          Select and configure models to be added.
                        </Typography>
                      </div>

                      <div className="add-model__field">
                        <SelectDropdown
                          id="add-model-models-provider"
                          label="Models"
                          placeholder={
                            !isProviderAuthenticated
                              ? "Authenticate to load models"
                              : isLoadingAvailableModels
                                ? "Loading models…"
                                : "Select models"
                          }
                          groups={visibleProviderModelGroups}
                          value={selectedProviderModels as SelectDropdownValue}
                          onValueChange={(v) => {
                            setSelectedProviderModels(Array.isArray(v) ? v : []);
                          }}
                          options={{
                            isMultiSelect: true,
                            isChipDisplay: true,
                            isSearchable: true,
                            isClearable: true,
                            groupsAsTabs: true,
                          }}
                          disabled={false}
                          isLoading={isProviderAuthenticated && isLoadingAvailableModels}
                          emptyMessage={
                            !isProviderAuthenticated
                              ? "Authenticate this provider to load models"
                              : isLoadingAvailableModels
                                ? "Loading models…"
                                : isAvailableModelsError
                                  ? "Couldn't load models — check the provider connection."
                                  : "No models available"
                          }
                        />
                      </div>
                    </div>

                    {selectedProviderModelCards.map((model) => (
                      <SelectedModelCard
                        key={model.key}
                        model={model}
                        config={modelConfigs[model.key]}
                        registrationName={resolveModelRegistrationName(model, modelConfigs[model.key])}
                        onModify={() => {
                          openEditModelModal(model);
                        }}
                        onRemove={() => {
                          removeSelectedModel(model);
                        }}
                      />
                    ))}
                  </div>
                </div>
              </TabContent>

              <TabContent tabId="self-hosted" className="add-model__tab-panel">
                <div className="add-model__coming-soon" role="status">
                  <div className="add-model__coming-soon-icon" aria-hidden>
                    <IconServer size={28} stroke={1.5} />
                  </div>
                  <Typography
                    Component="h3"
                    fontSize="fs16"
                    boldness="semibold"
                    className="add-model__coming-soon-title"
                  >
                    Self-hosted models are coming soon
                  </Typography>
                  <Typography
                    Component="p"
                    fontSize="fs14"
                    className="add-model__coming-soon-text"
                  >
                    Connecting your own self-hosted model server isn&apos;t available
                    yet. In the meantime, add models through a managed provider on the
                    Providers tab.
                  </Typography>
                </div>
              </TabContent>
            </TabGroup>
            </section>
          </FloatingLayerContext.Provider>,
        ]}
      />

      <ModelProviderConfigureModal
        open={configureModalOpen}
        onOpenChange={setConfigureModalOpen}
        flow={configureModalFlow}
        providerId={configureModalFlow === "providers" ? effectiveSelectedProviderId : null}
        providerName={configureModalFlow === "providers" ? selectedProviderName : null}
        onSave={(credentialId) => {
          if (configureModalFlow === "providers") {
            setIsProviderAuthenticated(true);
            if (credentialId) setSelectedCredentialId(credentialId);
          }
        }}
      />

      <EditModelModal
        open={editModelModalOpen}
        onOpenChange={handleEditModelModalOpenChange}
        model={editingModel}
        initialConfig={editingModel ? modelConfigs[editingModel.key] : undefined}
        provider={providerTab === "self-hosted" ? null : effectiveSelectedProviderId}
        onSave={(modelKey, config) =>
          setModelConfigs((prev) => ({ ...prev, [modelKey]: config }))
        }
      />

      {/*
       * RT-003 prompt-on-leave. Fires whenever `useBlocker` (above) catches
       * a navigation attempt with `isDirty === true`. The two callbacks
       * route the user's choice back to react-router:
       *   - Discard: blocker.proceed() lets the original navigation through.
       *   - Stay:    blocker.reset()   cancels the navigation, returning
       *              the URL to this route.
       */}
      <ConfirmDialog
        open={isBlocked}
        title="Discard changes?"
        description="You have unsaved changes. Are you sure you want to leave?"
        confirmLabel="Discard"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </>
  );
}

export { AddModel };
