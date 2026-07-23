import { useCallback, useState, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";
import {
  IconAlertTriangle,
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
import { KnowledgeBaseConfigDialog } from "../configure-dialogs/knowledge-base-config-dialog";
import { DEFAULT_KNOWLEDGE_BASE_CONFIG } from "../configure-dialogs/configure-dialogs.consts";
import type { KnowledgeBaseConfig } from "../configure-dialogs/configure-dialogs.types";

import type { AgentAttachedKB, AgentResourceRequirement } from "./agent-form.consts";
import { agentFormFieldPath, getFormValueAtPath } from "./agent-form-field-path";
import {
  buildAttachedKB,
  draftFromAttachedKB,
} from "./knowledge-bases-section.utils";
import { useKnowledgeBaseOptions } from "./use-knowledge-base-options";

interface KnowledgeBasesSectionProps {
  form: AnyReactFormApi;
  onConfigureKnowledgeBase?: (kbId: string) => void;
  /** Incomplete KB entries from the agent's `requirements` field. */
  kbRequirements?: AgentResourceRequirement[];
  errorMessage?: string | null;
  /** Binds the section to a nested instance path (e.g. template.agentInstances[0]). */
  fieldPrefix?: string;
  /** Renders the section header. Set false when nested under another heading. */
  showHeader?: boolean;
}

function toAppHref(path: string): string {
  return `${getAppBasePath()}${path.startsWith("/") ? path : `/${path}`}`;
}

type PendingKnowledgeBaseRemoval = {
  id: string;
  label: string;
};

function KnowledgeBaseActionsMenu({ onRemove }: { onRemove: () => void }): ReactElement {
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

function AttachedKBCard({
  kb,
  title,
  subtitle,
  onConfigure,
  onRemove,
  onDelete,
  hasRequirementError,
  requirementLabel,
}: {
  kb: AgentAttachedKB;
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
  const cardTitle = title ?? kb.name;
  const cardSubtitle = subtitle ?? "Connection to knowledge bases for context";
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
                {cardSubtitle}
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
            {handleRemove ? <KnowledgeBaseActionsMenu onRemove={handleRemove} /> : null}
          </div>
        </div>

        <div className="agent-form__feature-card-body">
          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Status
          </Typography>
          <span className="agent-form__status">
            {kb.status === "healthy" ? (
              <IconCircleCheck
                size={16}
                className="agent-form__status-icon agent-form__status-icon--healthy"
                aria-hidden="true"
              />
            ) : (
              <span className={`agent-form__status-dot agent-form__status-dot--${kb.status}`} />
            )}
            <Typography fontSize="fs14">{kb.status === "healthy" ? "Healthy" : kb.status}</Typography>
          </span>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Name
          </Typography>
          <span className="agent-form__sub-entity-name">
            <Typography fontSize="fs14" color="var(--primary-main, var(--link-primary, #0d6efd))">{kb.name}</Typography>
            <a
              href={toAppHref(`/${ROUTES.KNOWLEDGE_BASES}/${kb.id}`)}
              target="_blank"
              rel="noreferrer"
              className="agent-form__resource-icon-link"
              aria-label={`Open knowledge base "${kb.name}" in a new tab`}
            >
              <IconExternalLink size={14} aria-hidden="true" />
            </a>
          </span>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Top K
          </Typography>
          <Typography fontSize="fs14">
            {kb.ragConfig ? `${kb.ragConfig.topKChunks} chunks` : "—"}
          </Typography>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Reranking
          </Typography>
          <Typography fontSize="fs14">
            {kb.ragConfig?.rerankingEnabled ? "Enabled" : "Disabled"}
          </Typography>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            File scope
          </Typography>
          <Typography fontSize="fs14">
            {kb.fileUsage && !kb.fileUsage.startsWith("Top K:") ? kb.fileUsage : "—"}
          </Typography>
        </div>
      </Card>

      {hasRequirementError && (
        <div className="agent-form__resource-requirement-error" role="alert">
          <IconCircleX size={16} className="agent-form__resource-requirement-error-icon" aria-hidden="true" />
          <Typography fontSize="fs13">
            Knowledge base &quot;{requirementLabel || kb.name}&quot; must be configured to deploy this agent.
          </Typography>
        </div>
      )}
    </>
  );
}

function KnowledgeBaseRequirementCard({
  requirement,
  onConfigure,
  onRemove,
}: {
  requirement: AgentResourceRequirement;
  onConfigure: () => void;
  onRemove: () => void;
}): ReactElement {
  const label = requirement.label || "Knowledge base";
  const isRequired = requirement.required;
  return (
    <>
      <Card className="agent-form__configured-resource-card agent-form__configured-resource-card--unconfigured">
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
            <KnowledgeBaseActionsMenu onRemove={onRemove} />
          </div>
        </div>

        <div className="agent-form__feature-card-body agent-form__resource-body--unconfigured">
          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Status
          </Typography>
          <span className="agent-form__status">
            <IconAlertTriangle
              size={16}
              className="agent-form__status-icon agent-form__status-icon--warning"
              aria-hidden="true"
            />
            <Typography fontSize="fs14">Not configured</Typography>
          </span>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Details needed
          </Typography>
          <Typography fontSize="fs14">
            {requirement.description || "Configure this knowledge base before deployment."}
          </Typography>
        </div>
      </Card>

      {isRequired && (
        <div className="agent-form__resource-requirement-error" role="alert">
          <IconCircleX size={16} className="agent-form__resource-requirement-error-icon" aria-hidden="true" />
          <Typography fontSize="fs13">
            Knowledge base &quot;{label}&quot; must be configured to deploy this agent.
          </Typography>
        </div>
      )}
    </>
  );
}

function KnowledgeBasesSection({
  form,
  onConfigureKnowledgeBase,
  kbRequirements = [],
  errorMessage,
  fieldPrefix,
  showHeader = true,
}: KnowledgeBasesSectionProps): ReactElement {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [draft, setDraft] = useState<KnowledgeBaseConfig>(DEFAULT_KNOWLEDGE_BASE_CONFIG);
  // Id of the KB currently being edited; `null` means the dialog is in "add" mode.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRequirementId, setEditingRequirementId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingKnowledgeBaseRemoval | null>(null);

  const knowledgeBasesField = agentFormFieldPath(fieldPrefix, "knowledgeBases");
  const kbs = useStore(
    form.store,
    (s: { values: unknown }) =>
      getFormValueAtPath<AgentAttachedKB[]>(s.values, knowledgeBasesField) ?? [],
  );

  const { options: kbOptions } = useKnowledgeBaseOptions();

  const handleOpen = useCallback(() => {
    setEditingId(null);
    setEditingRequirementId(null);
    setDraft(DEFAULT_KNOWLEDGE_BASE_CONFIG);
    setIsDialogOpen(true);
  }, []);

  const handleConfigure = useCallback(
    (kb: AgentAttachedKB) => {
      onConfigureKnowledgeBase?.(kb.id);
      setEditingId(kb.id);
      setEditingRequirementId(null);
      setDraft(draftFromAttachedKB(kb));
      setIsDialogOpen(true);
    },
    [onConfigureKnowledgeBase],
  );

  const handleConfigureRequirement = useCallback((requirement: AgentResourceRequirement) => {
    setEditingId(null);
    setEditingRequirementId(requirement.id);
    setDraft({ ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: requirement.id });
    setIsDialogOpen(true);
  }, []);

  const handleRemoveRequirement = useCallback(
    (requirementId: string) => {
      form.setFieldValue(
        "requirements.knowledgeBases",
        (prev: AgentResourceRequirement[] = []) =>
          prev.filter((requirement) => requirement.id !== requirementId),
      );
    },
    [form],
  );

  const handleRequestRemoveRequirement = useCallback((requirement: AgentResourceRequirement) => {
    setPendingRemoval({
      id: requirement.id,
      label: requirement.label || "Knowledge base",
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

  const handleRemoveKnowledgeBase = useCallback(
    (kbId: string) => {
      form.setFieldValue(
        knowledgeBasesField,
        (prev: AgentAttachedKB[] = []) => prev.filter((kb) => kb.id !== kbId),
      );
      form.setFieldValue(
        "requirements.knowledgeBases",
        (prev: AgentResourceRequirement[] = []) =>
          prev.filter((requirement) => requirement.id !== kbId),
      );
    },
    [form, knowledgeBasesField],
  );

  const handleClose = useCallback(() => {
    setIsDialogOpen(false);
    setEditingId(null);
    setEditingRequirementId(null);
  }, []);

  const handleDraftChange = useCallback((next: Partial<KnowledgeBaseConfig>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const handleSave = useCallback(() => {
    const attached = buildAttachedKB(draft, kbOptions);
    if (attached) {
      form.setFieldValue(knowledgeBasesField, (prev: AgentAttachedKB[]) => {
        const list = prev ?? [];
        if (editingId) {
          const replaced = list.map((item) => (item.id === editingId ? attached : item));
          // De-dupe in case the user re-pointed the entry at a KB that's
          // already attached — the API treats `knowledgeBaseIds` as a set.
          return replaced.filter(
            (item, idx) => replaced.findIndex((i) => i.id === item.id) === idx,
          );
        }
        return list.some((item) => item.id === attached.id)
          ? list.map((item) => (item.id === attached.id ? attached : item))
          : [...list, attached];
      });
      const requirementIdToResolve = editingRequirementId ?? editingId;
      if (requirementIdToResolve) {
        form.setFieldValue(
          "requirements.knowledgeBases",
          (prev: AgentResourceRequirement[] = []) =>
            prev.filter((requirement) => requirement.id !== requirementIdToResolve),
        );
      }
    }
    setIsDialogOpen(false);
    setEditingId(null);
    setEditingRequirementId(null);
  }, [draft, editingId, editingRequirementId, form, kbOptions, knowledgeBasesField]);

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
            Knowledge bases
          </Typography>
        </div>
      )}

      <div className="agent-form__section-body">
        <div className="agent-form__resource-list">
          {kbRequirements
            .filter((requirement) => !kbs.some((kb) => kb.id === requirement.id))
            .map((requirement) => (
              <KnowledgeBaseRequirementCard
                key={requirement.id}
                requirement={requirement}
                onConfigure={() => handleConfigureRequirement(requirement)}
                onRemove={() => handleRequestRemoveRequirement(requirement)}
              />
            ))}
          {kbs.map((kb) => {
            const requirement = kbRequirements.find((r) => r.id === kb.id);
            return (
              <AttachedKBCard
                key={kb.id}
                kb={kb}
                onConfigure={() => handleConfigure(kb)}
                onRemove={() => handleRemoveKnowledgeBase(kb.id)}
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
          label="Add knowledge base"
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

      <KnowledgeBaseConfigDialog
        open={isDialogOpen}
        draft={draft}
        knowledgeBases={kbOptions}
        onClose={handleClose}
        onDraftChange={handleDraftChange}
        onSave={handleSave}
      />

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove unconfigured knowledge base?"
        description={`You are removing the unconfigured knowledge base "${pendingRemoval?.label ?? ""}". You can save and deploy only after unconfigured resources are configured or removed.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmRemoveRequirement}
        onCancel={handleCancelRemoveRequirement}
      />
    </section>
  );
}

export { KnowledgeBasesSection, AttachedKBCard };
export type { KnowledgeBasesSectionProps };
