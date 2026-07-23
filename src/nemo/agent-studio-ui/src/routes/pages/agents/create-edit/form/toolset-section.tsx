import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";
import {
  IconBox,
  IconCircleCheck,
  IconCircleX,
  IconDots,
  IconExternalLink,
  IconPlus,
} from "@tabler/icons-react";

import { ROUTES } from "@/routes/routes.consts";
import { getAppBasePath } from "@/consts/app-base-path";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Card } from "@/ui-lib/base-components/card/card";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { ToolsetConfigDialog } from "../configure-dialogs/toolset-config-dialog";
import { DEFAULT_TOOLSET_CONFIG } from "../configure-dialogs/configure-dialogs.consts";
import type {
  ToolsetConfig,
  ToolsetOption,
} from "../configure-dialogs/configure-dialogs.types";

import type { AgentAttachedToolset, AgentResourceRequirement } from "./agent-form.consts";
import { agentFormFieldPath, getFormValueAtPath } from "./agent-form-field-path";
import {
  buildAttachedToolset,
  enrichWithCatalog,
} from "./toolset-section.utils";
import { useToolsetOptions } from "./use-toolset-options";
import { useToolsetTools } from "./use-toolset-tools";

interface ToolsetSectionProps {
  form: AnyReactFormApi;
  onConfigureToolset?: (toolsetId: string) => void;
  /** Incomplete MCP server entries from the agent's `requirements` field. */
  mcpRequirements?: AgentResourceRequirement[];
  errorMessage?: string | null;
  /** Binds the section to a nested instance path (e.g. template.agentInstances[0]). */
  fieldPrefix?: string;
  /** Renders the section header. Set false when nested under another heading. */
  showHeader?: boolean;
}

function toAppHref(path: string): string {
  return `${getAppBasePath()}${path.startsWith("/") ? path : `/${path}`}`;
}

type PendingToolsetRemoval = {
  id: string;
  label: string;
};

function ToolsetActionsMenu({ onRemove }: { onRemove: () => void }): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="agent-form__resource-card-menu-trigger"
        aria-label="More actions"
      >
        <IconDots size={18} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="agent-form__resource-card-menu-content"
      >
        <DropdownMenuItem
          onClick={onRemove}
          className="agent-form__resource-card-menu-item"
        >
          <Typography Component="span" fontSize="fs14">
            Remove
          </Typography>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AttachedToolsetCard({
  toolset,
  title,
  subtitle,
  onConfigure,
  onRemove,
  onDelete,
  hasRequirementError,
  requirementLabel,
}: {
  toolset: AgentAttachedToolset;
  /** Overrides the default card title (used for template requirement labels). */
  title?: string;
  /** Overrides the default card subtitle (used for template requirement descriptions). */
  subtitle?: string;
  onConfigure?: () => void;
  onRemove?: () => void;
  onDelete?: () => void;
  hasRequirementError?: boolean;
  requirementLabel?: string;
}): ReactElement {
  const cardTitle = title ?? toolset.name;
  const handleRemove = onRemove ?? onDelete;

  return (
    <>
      <Card className="agent-form__configured-resource-card">
        <div className="agent-form__feature-card-header">
          <div className="agent-form__feature-card-title-row">
            <span className="agent-form__feature-card-icon" aria-hidden="true">
              <IconBox size={16} />
            </span>
            <Typography fontSize="fs14" boldness="semibold" isEllipsis>
              {cardTitle}
            </Typography>
            {subtitle ? (
              <Typography fontSize="fs13" color="var(--text-secondary)">
                {subtitle}
              </Typography>
            ) : null}
          </div>
          <div className="agent-form__feature-card-actions">
            <button
              type="button"
              className="agent-form__resource-link-button"
              onClick={onConfigure}
            >
              Configure
            </button>
            {handleRemove ? <ToolsetActionsMenu onRemove={handleRemove} /> : null}
          </div>
        </div>

        <div className="agent-form__feature-card-body">
          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Status
          </Typography>
          <span className="agent-form__status">
            {toolset.status === "healthy" ? (
              <IconCircleCheck
                size={16}
                className="agent-form__status-icon agent-form__status-icon--healthy"
                aria-hidden="true"
              />
            ) : (
              <span className={`agent-form__status-dot agent-form__status-dot--${toolset.status}`} />
            )}
            <Typography fontSize="fs14">
              {toolset.status === "healthy" ? "Healthy" : toolset.status}
            </Typography>
          </span>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Name
          </Typography>
          <span className="agent-form__sub-entity-name">
            <Typography fontSize="fs14" color="var(--primary-main, var(--link-primary, #0d6efd))">{toolset.name}</Typography>
            <a
              href={toAppHref(`/${ROUTES.TOOLSET}/${toolset.id}`)}
              target="_blank"
              rel="noreferrer"
              className="agent-form__resource-icon-link"
              aria-label={`Open toolset "${toolset.name}" in a new tab`}
            >
              <IconExternalLink size={14} aria-hidden="true" />
            </a>
          </span>

          {toolset.authMethod && toolset.authMethod !== "—" && (
            <>
              <Typography fontSize="fs14" className="agent-form__resource-row-label">
                Authentication type
              </Typography>
              <Typography fontSize="fs14">{toolset.authMethod}</Typography>
            </>
          )}

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Tools
          </Typography>
          <Typography fontSize="fs14">{toolset.tools.join(", ") || "—"}</Typography>
        </div>
      </Card>

      {hasRequirementError && (
        <div className="agent-form__resource-requirement-error" role="alert">
          <IconCircleX size={16} className="agent-form__resource-requirement-error-icon" aria-hidden="true" />
          <Typography fontSize="fs13">
            Toolset &quot;{requirementLabel || toolset.name}&quot; must be configured to deploy this agent.
          </Typography>
        </div>
      )}
    </>
  );
}

function ToolsetRequirementCard({
  requirement,
  onConfigure,
  onRemove,
}: {
  requirement: AgentResourceRequirement;
  onConfigure: () => void;
  onRemove: () => void;
}): ReactElement {
  const label = requirement.label || "Toolset";
  const isRequired = requirement.required;
  return (
    <>
      <Card className="agent-form__configured-resource-card">
        <div className="agent-form__feature-card-header">
          <div className="agent-form__feature-card-title-row">
            <span className="agent-form__feature-card-icon" aria-hidden="true">
              <IconBox size={16} />
            </span>
            <Typography fontSize="fs14" boldness="semibold" isEllipsis>
              {label}
            </Typography>
          </div>
          <div className="agent-form__feature-card-actions">
            <button
              type="button"
              className="agent-form__resource-link-button"
              onClick={onConfigure}
            >
              Configure
            </button>
            <ToolsetActionsMenu onRemove={onRemove} />
          </div>
        </div>

        <div className="agent-form__feature-card-body">
          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Status
          </Typography>
          <span className="agent-form__status">
            <span className="agent-form__status-dot agent-form__status-dot--unhealthy" />
            <Typography fontSize="fs14">Incomplete</Typography>
          </span>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Name
          </Typography>
          <Typography fontSize="fs14">{label}</Typography>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Details needed
          </Typography>
          <Typography fontSize="fs14">
            {requirement.description || "Configure this toolset before deployment."}
          </Typography>
        </div>
      </Card>

      {isRequired && (
        <div className="agent-form__resource-requirement-error" role="alert">
          <IconCircleX size={16} className="agent-form__resource-requirement-error-icon" aria-hidden="true" />
          <Typography fontSize="fs13">
            Toolset &quot;{label}&quot; must be configured to deploy this agent.
          </Typography>
        </div>
      )}
    </>
  );
}

function ToolsetSection({
  form,
  onConfigureToolset,
  mcpRequirements = [],
  errorMessage,
  fieldPrefix,
  showHeader = true,
}: ToolsetSectionProps): ReactElement {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [draft, setDraft] = useState<ToolsetConfig>(DEFAULT_TOOLSET_CONFIG);
  const [editingRequirementId, setEditingRequirementId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingToolsetRemoval | null>(null);

  const toolsetsField = agentFormFieldPath(fieldPrefix, "toolsets");
  const toolsets = useStore(
    form.store,
    (s: { values: unknown }) =>
      getFormValueAtPath<AgentAttachedToolset[]>(s.values, toolsetsField) ?? [],
  );

  const { options: toolsetOptions } = useToolsetOptions();

  // The list endpoint only carries each server's `allowedTools` names. Once a
  // toolset is picked we load its live tool catalog (with descriptions) and
  // splice those into the selected option, falling back to the allowlist when
  // the catalog can't be loaded.
  const {
    tools: liveTools,
    isLoading: toolsLoading,
    isError: toolsError,
    isReady: toolsReady,
  } = useToolsetTools(draft.toolsetId);

  const enrichedOptions = useMemo<ToolsetOption[]>(() => {
    if (!draft.toolsetId || !toolsReady) return toolsetOptions;
    return toolsetOptions.map((option) => {
      if (option.id !== draft.toolsetId) return option;
      // The live catalog is every tool the server binary exposes, but an agent
      // may only use tools the server's own allow-list permits. Intersect the
      // two so the picker never offers a tool the runtime would drop. A missing
      // allow-list (config-service returns `null`/`undefined` when a server has
      // no restriction) means every live tool is allowed — guard with
      // `Array.isArray` so a `null` never reaches `.includes` and crashes render.
      const allow = option.allowedToolNames;
      const scopedTools = Array.isArray(allow)
        ? liveTools.filter((tool) => allow.includes(tool.id))
        : liveTools;
      return { ...option, tools: scopedTools };
    });
  }, [toolsetOptions, draft.toolsetId, toolsReady, liveTools]);

  const handleOpen = useCallback(() => {
    setEditingRequirementId(null);
    setDraft(DEFAULT_TOOLSET_CONFIG);
    setIsDialogOpen(true);
  }, []);

  // Re-opens the dialog for an already-attached toolset, pre-populated with
  // its server id and selected tools. Tool ids are the tool names (see
  // `useToolsetTools`/`useToolsetOptions`), so the stored names double as ids.
  const handleConfigure = useCallback(
    (toolset: AgentAttachedToolset) => {
      onConfigureToolset?.(toolset.id);
      setEditingRequirementId(null);
      setDraft({ toolsetId: toolset.id, selectedToolIds: toolset.tools });
      setIsDialogOpen(true);
    },
    [onConfigureToolset],
  );

  const handleConfigureRequirement = useCallback((requirement: AgentResourceRequirement) => {
    setEditingRequirementId(requirement.id);
    setDraft({ ...DEFAULT_TOOLSET_CONFIG, toolsetId: requirement.id });
    setIsDialogOpen(true);
  }, []);

  const handleRemoveRequirement = useCallback(
    (requirementId: string) => {
      form.setFieldValue(
        "requirements.mcpServers",
        (prev: AgentResourceRequirement[] = []) =>
          prev.filter((requirement) => requirement.id !== requirementId),
      );
    },
    [form],
  );

  const handleRequestRemoveRequirement = useCallback((requirement: AgentResourceRequirement) => {
    setPendingRemoval({
      id: requirement.id,
      label: requirement.label || "Toolset",
    });
  }, []);

  const handleCancelRemoveRequirement = useCallback(() => {
    setPendingRemoval(null);
  }, []);

  const handleConfirmRemoveRequirement = useCallback(() => {
    if (!pendingRemoval) return;
    handleRemoveRequirement(pendingRemoval.id);
    setPendingRemoval(null);
  }, [handleRemoveRequirement, pendingRemoval]);

  const handleRemoveToolset = useCallback(
    (toolsetId: string) => {
      form.setFieldValue(
        toolsetsField,
        (prev: AgentAttachedToolset[] = []) => prev.filter((toolset) => toolset.id !== toolsetId),
      );
      form.setFieldValue(
        "requirements.mcpServers",
        (prev: AgentResourceRequirement[] = []) =>
          prev.filter((requirement) => requirement.id !== toolsetId),
      );
    },
    [form, toolsetsField],
  );

  const handleClose = useCallback(() => {
    setIsDialogOpen(false);
    setEditingRequirementId(null);
  }, []);

  const handleDraftChange = useCallback((next: Partial<ToolsetConfig>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const handleSave = useCallback(() => {
    const attached = buildAttachedToolset(draft, enrichedOptions);
    if (attached) {
      form.setFieldValue(toolsetsField, (prev: AgentAttachedToolset[]) => {
        const existing = prev ?? [];
        // Replace if already attached so toggling tools re-saves cleanly,
        // otherwise append.
        const idx = existing.findIndex((t) => t.id === attached.id);
        if (idx >= 0) {
          const next = existing.slice();
          next[idx] = attached;
          return next;
        }
        return [...existing, attached];
      });
      if (editingRequirementId) {
        form.setFieldValue(
          "requirements.mcpServers",
          (prev: AgentResourceRequirement[] = []) =>
            prev.filter((requirement) => requirement.id !== editingRequirementId),
        );
      }
    }
    setIsDialogOpen(false);
    setEditingRequirementId(null);
  }, [draft, editingRequirementId, form, enrichedOptions, toolsetsField]);

  return (
    <section className="agent-form__section">
      {showHeader && (
        <div className="agent-form__section-header">
          <Typography
            Component="h2"
            fontSize="fs16"
            boldness="semibold"
            className="agent-form__section-title"
          >
            Toolset
          </Typography>
        </div>
      )}

      <div className="agent-form__section-body">
        <div className="agent-form__resource-list">
          {mcpRequirements
            .filter((requirement) => !toolsets.some((toolset) => toolset.id === requirement.id))
            .map((requirement) => (
              <ToolsetRequirementCard
                key={requirement.id}
                requirement={requirement}
                onConfigure={() => handleConfigureRequirement(requirement)}
                onRemove={() => handleRequestRemoveRequirement(requirement)}
              />
            ))}
          {toolsets.map((toolset) => {
            const enriched = enrichWithCatalog(toolset, enrichedOptions);
            const requirement = mcpRequirements.find((r) => r.id === enriched.id);
            return (
              <AttachedToolsetCard
                key={enriched.id}
                toolset={enriched}
                onConfigure={() => handleConfigure(enriched)}
                onRemove={() => handleRemoveToolset(enriched.id)}
                hasRequirementError={requirement?.required === true}
                requirementLabel={requirement?.label}
              />
            );
          })}
        </div>

        <Button
          type="button"
          variant="outline"
          size="medium"
          label="Add toolset"
          icon={<IconPlus size={16} />}
          className="agent-form__add-resource"
          onClick={handleOpen}
        />
        {errorMessage && (
          <Typography
            Component="p"
            fontSize="fs13"
            color="var(--notification-error)"
            className="agent-form__inline-error"
          >
            {errorMessage}
          </Typography>
        )}
      </div>

      <ToolsetConfigDialog
        open={isDialogOpen}
        draft={draft}
        toolsets={enrichedOptions}
        toolsLoading={toolsLoading}
        toolsError={toolsError}
        onClose={handleClose}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
      />

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove unconfigured toolset?"
        description={`You are removing the unconfigured toolset "${pendingRemoval?.label ?? ""}". You can save and deploy only after unconfigured resources are configured or removed.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmRemoveRequirement}
        onCancel={handleCancelRemoveRequirement}
      />
    </section>
  );
}

export { ToolsetSection, AttachedToolsetCard };
export type { ToolsetSectionProps };
