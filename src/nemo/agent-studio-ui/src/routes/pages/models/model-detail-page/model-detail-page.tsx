import { type ReactElement } from "react"
import { useNavigate, useParams } from "react-router"
import {
  IconRefresh,
  IconChevronDown,
} from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { Spinner } from "@/ui-lib/base-components/spinner/spinner"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { SummaryDetailsTemplate } from "@/components/summary-details-template/summary-details-template"
import type { SummaryField, TabPanel } from "@/components/summary-details-template/summary-details-template.types"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu"
import { ROUTES } from "@/routes/routes.consts"
import { useAppSelector } from "@/store"
import { projectContextSelector } from "@/store/selectors/project-context.selector"
import {
  useDeleteModelMutation,
  useGetModelPricingDefaultsQuery,
  useListModelDependentsQuery,
} from "@/routes/pages/models/models.api"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { useGetModelQuery } from "./model-detail-page.api"
import { countDependents, formatModelDeleteError } from "./model-dependents.utils"
import { OverviewPanel } from "./panels/overview-panel"
import { AssociatedResourcesPanel } from "./panels/associated-resources-panel"
import { ActivityPanel } from "./panels/activity-panel"
import { STATUS_MAP } from "./model-detail-page.consts"
import "./model-detail-page.scss"

// A 404 from the API means "model with this id does not exist" — treat it as a
// distinct UX from a generic transport / 5xx failure. Any other error shape
// (network, 5xx, malformed body) falls through to the "Failed to load" branch.
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  )
}

function resolveModelStatus(status: string | undefined) {
  const normalized = (status ?? "").toLowerCase()
  if (normalized in STATUS_MAP) {
    return STATUS_MAP[normalized as keyof typeof STATUS_MAP]
  }
  if (normalized === "active" || normalized === "connected" || normalized === "healthy") {
    return STATUS_MAP.healthy
  }
  if (normalized === "inactive" || normalized === "degraded" || normalized === "warning") {
    return STATUS_MAP.warning
  }
  return STATUS_MAP.error
}

function ModelDetailPage(): ReactElement {
  const navigate = useNavigate()
  const { modelId } = useParams<{ modelId: string }>()
  const projectId = useAppSelector(projectContextSelector.activeProjectId)
  const [deleteModel, { isLoading: isDeleting }] = useDeleteModelMutation()
  const { data: model, isLoading, isError, error, refetch } = useGetModelQuery(
    { projectId, modelId: modelId ?? "" },
    { skip: !modelId || !projectId },
  )
  const { data: dependentsPage } = useListModelDependentsQuery(
    { projectId: projectId ?? "", modelId: modelId ?? "" },
    { skip: !modelId || !projectId },
  )
  // Provider list (catalog) pricing for the (provider, model). Fetched
  // separately from the model so the detail page renders immediately — the
  // datasheet lookup can block briefly on its first cluster-wide load. Only
  // needed to fill in a default price when the model has no custom override.
  const { data: pricingDefaults } = useGetModelPricingDefaultsQuery(
    {
      projectId: projectId ?? "",
      provider: model?.provider ?? "",
      model: model?.model ?? "",
    },
    {
      skip:
        !projectId ||
        !model?.provider ||
        model.provider === "Unknown" ||
        !model?.model,
    },
  )

  const renderNotFound = (): ReactElement => (
    <div className="model-detail">
      <Typography Component="h1" fontSize="fs20" boldness="semibold">
        Model not found.
      </Typography>
      <Button
        variant="flat"
        size="medium"
        label="Back to Models"
        onClick={() => navigate(`/${ROUTES.MODELS}`)}
      />
    </div>
  )

  if (isLoading) {
    return (
      <div className="model-detail model-detail__loading">
        <Spinner size="fitContent" />
      </div>
    )
  }

  // Check 404 BEFORE falling through to the success branch. RTK Query retains
  // the last successful `data` when a subsequent request errors, so a model
  // that was loaded successfully and then deleted (404 on refetch) would
  // otherwise render the stale success UI. See PR #298 review thread.
  if (isError && isNotFoundError(error)) {
    return renderNotFound()
  }

  if (isError) {
    return (
      <div className="model-detail">
        <Typography Component="h1" fontSize="fs20" boldness="semibold">
          Failed to load model.
        </Typography>
        <Button
          variant="flat"
          size="medium"
          label="Back to Models"
          onClick={() => navigate(`/${ROUTES.MODELS}`)}
        />
      </div>
    )
  }

  if (!model) {
    return renderNotFound()
  }

  const modelStatus = resolveModelStatus(model.status)
  const activityEvents = model.activityEvents ?? []
  const modelName = model.name ?? model.id ?? "Unnamed model"
  const modelType = model.type ?? "LLM"
  const modelProvider = model.provider ?? "Unknown"
  const dependentCount = countDependents(dependentsPage)
  const dependents = (dependentsPage?.items ?? []).map((item) => ({
    kind: item.kind,
    id: item.id,
    name: item.name ?? item.id,
    relation: item.relation,
  }))

  // -- Summary strip fields --
  const summaryFields: SummaryField[] = [
    { label: "Name", value: modelName },
    {
      label: "Status",
      value: (
        <div className={`model-detail__status ${modelStatus.className}`}>
          {modelStatus.icon}
          <Typography fontSize="fs14" boldness="semibold">
            {modelStatus.label}
          </Typography>
        </div>
      ),
    },
    { label: "Type", value: modelType },
    { label: "Provider", value: modelProvider },
    { label: "Associated resources", value: String(dependentCount) },
  ]

  // -- Tab panels --
  // Associated resources tab label derives its count directly from the data array
  // so it stays in sync as the list grows or shrinks.
  const tabPanels: TabPanel[] = [
    {
      tab: { id: "overview", label: "Overview" },
      content: (
        <OverviewPanel
          model={model}
          dependentCount={dependentCount}
          pricingDefaults={pricingDefaults}
        />
      ),
    },
    {
      tab: {
        id: "associated-resources",
        label: `Associated resources (${dependentCount})`,
      },
      content: <AssociatedResourcesPanel dependents={dependents} />,
    },
    {
      tab: { id: "activity", label: "Activity" },
      content: <ActivityPanel events={activityEvents} onRefresh={refetch} />,
    },
  ]

  return (
    <div className="model-detail">
      <SummaryDetailsTemplate
        title="Model details"
        breadcrumbs={[
          { label: "Models", href: `/${ROUTES.MODELS}` },
          { label: model.id, href: `/${ROUTES.MODELS}/${model.id}` },
        ]}
        actions={(
          // Action-bar wiring status:
          //   - Refresh: live (refetches the RTK Query).
          //   - Edit: navigates to /models/:id/edit, which renders the
          //     ModelEditPage placeholder until the BE mutation endpoint
          //     lands (PR #298 review). Routing is real so the action is
          //     not a dead control; the placeholder page itself communicates
          //     the deferred state to the user.
          //   - Actions dropdown (Validate connection / Duplicate / Delete):
          //     rendered visibly disabled because each depends on a /models
          //     mutation endpoint (POST/PATCH/DELETE) that isn't part of the
          //     current backend handoff. They will be enabled and wired in
          //     the follow-up PR once the BE endpoints land. See
          //     FIXME(backend-handoff): in `ui/src/api/model-api.slice.ts`.
          <>
            <Button
              variant="icon"
              size="large"
              icon={<IconRefresh size={18} />}
              aria-label="Refresh"
              onClick={refetch}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="solid"
                    size="large"
                    label="Actions"
                    icon={<IconChevronDown size={16} />}
                  />
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => navigate(`/${ROUTES.MODELS}/${model.id}/${ROUTES.EDIT}`)}
                >
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={isDeleting}
                  onClick={() => {
                    if (!projectId) return
                    const confirmed = window.confirm(
                      `Are you sure you want to delete "${modelName}"?`,
                    )
                    if (!confirmed) return
                    void deleteModel({ projectId, modelId: model.id })
                      .unwrap()
                      .then(() => {
                        toast.success(`Model "${modelName}" deleted.`)
                        navigate(`/${ROUTES.MODELS}`)
                      })
                      .catch((deleteError) => {
                        toast.error(formatModelDeleteError(deleteError))
                      })
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        summaryFields={summaryFields}
        tabPanels={tabPanels}
      />
    </div>
  )
}

export { ModelDetailPage }
