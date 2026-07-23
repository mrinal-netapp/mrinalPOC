import { useCallback, useMemo, useState, type ReactElement } from "react";
import {
  IconAlertTriangle,
  IconBox,
  IconCircleMinus,
  IconDots,
  IconPlus,
} from "@tabler/icons-react";
import { useStore } from "@tanstack/react-store";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Button } from "@/ui-lib/base-components/button/button";
import { Card } from "@/ui-lib/base-components/card/card";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { KnowledgeBaseConfigDialog } from "../configure-dialogs/knowledge-base-config-dialog";
import { ToolsetConfigDialog } from "../configure-dialogs/toolset-config-dialog";
import { DEFAULT_KNOWLEDGE_BASE_CONFIG, DEFAULT_TOOLSET_CONFIG } from "../configure-dialogs/configure-dialogs.consts";
import type { KnowledgeBaseConfig, ToolsetConfig, ToolsetOption } from "../configure-dialogs/configure-dialogs.types";

import type { AgentAttachedKB, AgentAttachedToolset, AgentTemplateAgentInstanceValues } from "./agent-form.consts";
import { agentFormFieldPath, getFormValueAtPath } from "./agent-form-field-path";
import {
  AttachedKBCard,
} from "./knowledge-bases-section";
import { buildAttachedKB, draftFromAttachedKB } from "./knowledge-bases-section.utils";
import {
  AttachedToolsetCard,
} from "./toolset-section";
import { buildAttachedToolset, enrichWithCatalog } from "./toolset-section.utils";
import type {
  AgentTemplateAgentRequirements,
  AgentTemplateResourceRequirement,
} from "./agent-templates.consts";
import {
  activeKbRequirements,
  activeMcpRequirements,
  isKbRequirementConfigured,
  isMcpRequirementConfigured,
} from "./template-agent.utils";
import { useKnowledgeBaseOptions } from "./use-knowledge-base-options";
import { useToolsetOptions } from "./use-toolset-options";
import { useToolsetTools } from "./use-toolset-tools";

interface TemplateAgentRequirementsSectionProps {
  form: AnyReactFormApi;
  fieldPrefix: string;
  requirements: AgentTemplateAgentRequirements;
  /** When set, validation has flagged unmet required KBs (deploy attempt). */
  knowledgeBasesError?: string;
  /** When set, validation has flagged unmet required toolsets (deploy attempt). */
  toolsetsError?: string;
}

type RequirementKind = "Knowledge base" | "Toolset";

/** Card for a template requirement the user has not configured yet. */
function UnconfiguredRequirementCard({
  kind,
  requirement,
  showError,
  onConfigure,
  onRemove,
}: {
  kind: RequirementKind;
  requirement: AgentTemplateResourceRequirement;
  showError: boolean;
  onConfigure: () => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <Card className="agent-form__template-agent-summary-card">
      <div className="agent-form__template-agent-summary-header">
        <div className="agent-form__feature-card-title-row">
          <span className="agent-form__feature-card-icon" aria-hidden="true">
            <IconBox size={16} />
          </span>
          <span className="agent-form__template-agent-title">
            <Typography fontSize="fs14" boldness="semibold">
              {kind}
            </Typography>
            {!requirement.required && (
              <Typography fontSize="fs12" color="var(--text-secondary)">
                Optional
              </Typography>
            )}
          </span>
        </div>
        <div className="agent-form__template-agent-actions">
          <button
            type="button"
            className="agent-form__resource-link-button"
            onClick={onConfigure}
          >
            Configure
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="icon"
                  size="small"
                  icon={<IconDots size={16} />}
                  aria-label="More actions"
                />
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="agent-form__resource-body">
        <Typography fontSize="fs14" className="agent-form__resource-row-label">
          Status
        </Typography>
        {requirement.required ? (
          <span className="agent-form__profile-status-warning">
            <IconAlertTriangle size={16} aria-hidden="true" />
            <Typography fontSize="fs14">Not configured</Typography>
          </span>
        ) : (
          <span className="agent-form__status agent-form__status--disabled">
            <IconCircleMinus size={16} aria-hidden="true" />
            <Typography fontSize="fs14">Disabled</Typography>
          </span>
        )}

        {requirement.description && (
          <>
            <Typography fontSize="fs14" className="agent-form__resource-row-label">
              Why this is needed
            </Typography>
            <Typography fontSize="fs14">{requirement.description}</Typography>
          </>
        )}
      </div>

      {requirement.required && showError && (
        <div className="agent-form__template-requirement-error">
          <Typography fontSize="fs13" color="var(--notification-error)">
            {kind} &ldquo;{requirement.label}&rdquo; must be configured or removed from the
            template in order to deploy this agent.
          </Typography>
        </div>
      )}
    </Card>
  );
}

function TemplateAgentRequirementsSection({
  form,
  fieldPrefix,
  requirements,
  knowledgeBasesError,
  toolsetsError,
}: TemplateAgentRequirementsSectionProps): ReactElement {
  const knowledgeBasesField = agentFormFieldPath(fieldPrefix, "knowledgeBases");
  const toolsetsField = agentFormFieldPath(fieldPrefix, "toolsets");
  const satisfiedKbField = agentFormFieldPath(fieldPrefix, "satisfiedKbRequirementIds");
  const satisfiedMcpField = agentFormFieldPath(fieldPrefix, "satisfiedMcpRequirementIds");
  const kbAttachmentsField = agentFormFieldPath(fieldPrefix, "kbRequirementAttachments");
  const mcpAttachmentsField = agentFormFieldPath(fieldPrefix, "mcpRequirementAttachments");
  const removedKbField = agentFormFieldPath(fieldPrefix, "removedKbRequirementIds");
  const removedMcpField = agentFormFieldPath(fieldPrefix, "removedMcpRequirementIds");

  const instance = useStore(form.store, (s) =>
    getFormValueAtPath<AgentTemplateAgentInstanceValues>(s.values, fieldPrefix),
  );

  const kbRequirements = instance ? activeKbRequirements(requirements, instance) : [];
  const toolRequirements = instance ? activeMcpRequirements(requirements, instance) : [];

  // Attachments claimed by a requirement are rendered under that requirement;
  // anything else is an "extra" resource the user added freely.
  const claimedKbIds = useMemo(
    () => new Set(Object.values(instance?.kbRequirementAttachments ?? {})),
    [instance?.kbRequirementAttachments],
  );
  const claimedToolsetIds = useMemo(
    () => new Set(Object.values(instance?.mcpRequirementAttachments ?? {})),
    [instance?.mcpRequirementAttachments],
  );
  const extraKbs = (instance?.knowledgeBases ?? []).filter((kb) => !claimedKbIds.has(kb.id));
  const extraToolsets = (instance?.toolsets ?? []).filter(
    (toolset) => !claimedToolsetIds.has(toolset.id),
  );

  const [kbDialogOpen, setKbDialogOpen] = useState(false);
  const [toolsetDialogOpen, setToolsetDialogOpen] = useState(false);
  const [kbDraft, setKbDraft] = useState<KnowledgeBaseConfig>(DEFAULT_KNOWLEDGE_BASE_CONFIG);
  const [toolsetDraft, setToolsetDraft] = useState<ToolsetConfig>(DEFAULT_TOOLSET_CONFIG);
  const [editingKbId, setEditingKbId] = useState<string | null>(null);
  const [pendingKbRequirementId, setPendingKbRequirementId] = useState<string | null>(null);
  const [editingToolsetId, setEditingToolsetId] = useState<string | null>(null);
  const [pendingToolRequirementId, setPendingToolRequirementId] = useState<string | null>(null);

  const { options: kbOptions } = useKnowledgeBaseOptions();
  const { options: toolsetOptions } = useToolsetOptions();
  const {
    tools: liveTools,
    isLoading: toolsLoading,
    isError: toolsError,
    isReady: toolsReady,
  } = useToolsetTools(toolsetDraft.toolsetId);

  const enrichedToolsetOptions = useMemo<ToolsetOption[]>(() => {
    if (!toolsetDraft.toolsetId || !toolsReady) return toolsetOptions;
    return toolsetOptions.map((option) =>
      option.id === toolsetDraft.toolsetId ? { ...option, tools: liveTools } : option,
    );
  }, [toolsetOptions, toolsetDraft.toolsetId, toolsReady, liveTools]);

  const getRequirementKb = useCallback(
    (requirementId: string): AgentAttachedKB | undefined => {
      const attachedId = instance?.kbRequirementAttachments?.[requirementId];
      if (!attachedId) return undefined;
      return instance?.knowledgeBases.find((kb) => kb.id === attachedId);
    },
    [instance?.kbRequirementAttachments, instance?.knowledgeBases],
  );

  const getRequirementToolset = useCallback(
    (requirementId: string): AgentAttachedToolset | undefined => {
      const attachedId = instance?.mcpRequirementAttachments?.[requirementId];
      if (!attachedId) return undefined;
      return instance?.toolsets.find((toolset) => toolset.id === attachedId);
    },
    [instance?.mcpRequirementAttachments, instance?.toolsets],
  );

  // -- Open / configure handlers ------------------------------------------------

  const handleOpenKbRequirement = useCallback((requirementId: string) => {
    setEditingKbId(null);
    setPendingKbRequirementId(requirementId);
    setKbDraft({ ...DEFAULT_KNOWLEDGE_BASE_CONFIG, knowledgeBaseId: "" });
    setKbDialogOpen(true);
  }, [setEditingKbId, setPendingKbRequirementId, setKbDraft, setKbDialogOpen]);

  const handleOpenKbAdd = useCallback(() => {
    setEditingKbId(null);
    setPendingKbRequirementId(null);
    setKbDraft(DEFAULT_KNOWLEDGE_BASE_CONFIG);
    setKbDialogOpen(true);
  }, [setEditingKbId, setPendingKbRequirementId, setKbDraft, setKbDialogOpen]);

  const handleConfigureKb = useCallback(
    (kb: AgentAttachedKB, requirementId: string | null) => {
      setEditingKbId(kb.id);
      setPendingKbRequirementId(requirementId);
      setKbDraft(draftFromAttachedKB(kb));
      setKbDialogOpen(true);
    },
    [setEditingKbId, setPendingKbRequirementId, setKbDraft, setKbDialogOpen],
  );

  const handleOpenToolsetRequirement = useCallback((requirementId: string) => {
    setEditingToolsetId(null);
    setPendingToolRequirementId(requirementId);
    setToolsetDraft({ ...DEFAULT_TOOLSET_CONFIG, toolsetId: "" });
    setToolsetDialogOpen(true);
  }, [setEditingToolsetId, setPendingToolRequirementId, setToolsetDraft, setToolsetDialogOpen]);

  const handleOpenToolsetAdd = useCallback(() => {
    setEditingToolsetId(null);
    setPendingToolRequirementId(null);
    setToolsetDraft(DEFAULT_TOOLSET_CONFIG);
    setToolsetDialogOpen(true);
  }, [setEditingToolsetId, setPendingToolRequirementId, setToolsetDraft, setToolsetDialogOpen]);

  const handleConfigureToolset = useCallback(
    (toolset: AgentAttachedToolset, requirementId: string | null) => {
      setEditingToolsetId(toolset.id);
      setPendingToolRequirementId(requirementId);
      setToolsetDraft({ toolsetId: toolset.id, selectedToolIds: toolset.tools });
      setToolsetDialogOpen(true);
    },
    [setEditingToolsetId, setPendingToolRequirementId, setToolsetDraft, setToolsetDialogOpen],
  );

  // -- Save handlers ------------------------------------------------------------

  const handleSaveKb = useCallback(() => {
    const attached = buildAttachedKB(kbDraft, kbOptions);
    if (attached) {
      form.setFieldValue(knowledgeBasesField, (prev: AgentAttachedKB[] = []) => {
        if (editingKbId) {
          return prev.map((item) => (item.id === editingKbId ? attached : item));
        }
        const withoutDuplicate = prev.filter((item) => item.id !== attached.id);
        return [...withoutDuplicate, attached];
      });
      if (pendingKbRequirementId) {
        form.setFieldValue(satisfiedKbField, (prev: string[] = []) =>
          prev.includes(pendingKbRequirementId) ? prev : [...prev, pendingKbRequirementId],
        );
        form.setFieldValue(kbAttachmentsField, (prev: Record<string, string> = {}) => ({
          ...prev,
          [pendingKbRequirementId]: attached.id,
        }));
      }
    }
    setKbDialogOpen(false);
    setEditingKbId(null);
    setPendingKbRequirementId(null);
  }, [
    editingKbId,
    form,
    kbAttachmentsField,
    kbDraft,
    kbOptions,
    knowledgeBasesField,
    pendingKbRequirementId,
    setKbDialogOpen,
    setEditingKbId,
    setPendingKbRequirementId,
    satisfiedKbField,
  ]);

  const handleSaveToolset = useCallback(() => {
    const attached = buildAttachedToolset(toolsetDraft, enrichedToolsetOptions);
    if (attached) {
      form.setFieldValue(toolsetsField, (prev: AgentAttachedToolset[] = []) => {
        if (editingToolsetId) {
          return prev.map((item) => (item.id === editingToolsetId ? attached : item));
        }
        const withoutDuplicate = prev.filter((item) => item.id !== attached.id);
        return [...withoutDuplicate, attached];
      });
      if (pendingToolRequirementId) {
        form.setFieldValue(satisfiedMcpField, (prev: string[] = []) =>
          prev.includes(pendingToolRequirementId) ? prev : [...prev, pendingToolRequirementId],
        );
        form.setFieldValue(mcpAttachmentsField, (prev: Record<string, string> = {}) => ({
          ...prev,
          [pendingToolRequirementId]: attached.id,
        }));
      }
    }
    setToolsetDialogOpen(false);
    setEditingToolsetId(null);
    setPendingToolRequirementId(null);
  }, [
    editingToolsetId,
    enrichedToolsetOptions,
    form,
    mcpAttachmentsField,
    pendingToolRequirementId,
    setToolsetDialogOpen,
    setEditingToolsetId,
    setPendingToolRequirementId,
    satisfiedMcpField,
    toolsetDraft,
    toolsetsField,
  ]);

  // -- Remove handlers ----------------------------------------------------------

  const removeKbRequirement = useCallback(
    (requirementId: string) => {
      const attachedId = instance?.kbRequirementAttachments?.[requirementId];
      form.setFieldValue(removedKbField, (prev: string[] = []) =>
        prev.includes(requirementId) ? prev : [...prev, requirementId],
      );
      form.setFieldValue(satisfiedKbField, (prev: string[] = []) =>
        prev.filter((id) => id !== requirementId),
      );
      form.setFieldValue(kbAttachmentsField, (prev: Record<string, string> = {}) => {
        const next = { ...prev };
        delete next[requirementId];
        return next;
      });
      if (attachedId) {
        form.setFieldValue(knowledgeBasesField, (prev: AgentAttachedKB[] = []) =>
          prev.filter((kb) => kb.id !== attachedId),
        );
      }
    },
    [form, instance?.kbRequirementAttachments, kbAttachmentsField, knowledgeBasesField, removedKbField, satisfiedKbField],
  );

  const removeToolsetRequirement = useCallback(
    (requirementId: string) => {
      const attachedId = instance?.mcpRequirementAttachments?.[requirementId];
      form.setFieldValue(removedMcpField, (prev: string[] = []) =>
        prev.includes(requirementId) ? prev : [...prev, requirementId],
      );
      form.setFieldValue(satisfiedMcpField, (prev: string[] = []) =>
        prev.filter((id) => id !== requirementId),
      );
      form.setFieldValue(mcpAttachmentsField, (prev: Record<string, string> = {}) => {
        const next = { ...prev };
        delete next[requirementId];
        return next;
      });
      if (attachedId) {
        form.setFieldValue(toolsetsField, (prev: AgentAttachedToolset[] = []) =>
          prev.filter((toolset) => toolset.id !== attachedId),
        );
      }
    },
    [form, instance?.mcpRequirementAttachments, mcpAttachmentsField, removedMcpField, satisfiedMcpField, toolsetsField],
  );

  const removeExtraKb = useCallback(
    (kbId: string) => {
      form.setFieldValue(knowledgeBasesField, (prev: AgentAttachedKB[] = []) =>
        prev.filter((kb) => kb.id !== kbId),
      );
    },
    [form, knowledgeBasesField],
  );

  const removeExtraToolset = useCallback(
    (toolsetId: string) => {
      form.setFieldValue(toolsetsField, (prev: AgentAttachedToolset[] = []) =>
        prev.filter((toolset) => toolset.id !== toolsetId),
      );
    },
    [form, toolsetsField],
  );

  const hasKbContent = kbRequirements.length > 0 || extraKbs.length > 0;
  const hasToolsetContent = toolRequirements.length > 0 || extraToolsets.length > 0;

  return (
    <>
      <section className="agent-form__section">
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
        <div className="agent-form__section-body">
          {hasKbContent && (
            <div className="agent-form__resource-list">
              {kbRequirements.map((requirement) => {
                if (isKbRequirementConfigured(requirement.id, instance!)) {
                  const kb = getRequirementKb(requirement.id);
                  if (!kb) return null;
                  return (
                    <AttachedKBCard
                      key={requirement.id}
                      kb={kb}
                      title="Knowledge base"
                      subtitle={requirement.required ? undefined : "Optional"}
                      onConfigure={() => handleConfigureKb(kb, requirement.id)}
                      onDelete={() => removeKbRequirement(requirement.id)}
                    />
                  );
                }
                return (
                  <UnconfiguredRequirementCard
                    key={requirement.id}
                    kind="Knowledge base"
                    requirement={requirement}
                    showError={Boolean(knowledgeBasesError)}
                    onConfigure={() => handleOpenKbRequirement(requirement.id)}
                    onRemove={() => removeKbRequirement(requirement.id)}
                  />
                );
              })}

              {extraKbs.map((kb) => (
                <AttachedKBCard
                  key={kb.id}
                  kb={kb}
                  title="Knowledge base"
                  onConfigure={() => handleConfigureKb(kb, null)}
                  onDelete={() => removeExtraKb(kb.id)}
                />
              ))}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="medium"
            label="Add knowledge base"
            icon={<IconPlus size={16} />}
            className="agent-form__add-resource"
            onClick={handleOpenKbAdd}
          />
        </div>
      </section>

      <section className="agent-form__section">
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
        <div className="agent-form__section-body">
          {hasToolsetContent && (
            <div className="agent-form__resource-list">
              {toolRequirements.map((requirement) => {
                if (isMcpRequirementConfigured(requirement.id, instance!)) {
                  const toolset = getRequirementToolset(requirement.id);
                  if (!toolset) return null;
                  const enriched = enrichWithCatalog(toolset, toolsetOptions);
                  return (
                    <AttachedToolsetCard
                      key={requirement.id}
                      toolset={enriched}
                      title="Toolset"
                      subtitle={requirement.required ? undefined : "Optional"}
                      onConfigure={() => handleConfigureToolset(enriched, requirement.id)}
                      onDelete={() => removeToolsetRequirement(requirement.id)}
                    />
                  );
                }
                return (
                  <UnconfiguredRequirementCard
                    key={requirement.id}
                    kind="Toolset"
                    requirement={requirement}
                    showError={Boolean(toolsetsError)}
                    onConfigure={() => handleOpenToolsetRequirement(requirement.id)}
                    onRemove={() => removeToolsetRequirement(requirement.id)}
                  />
                );
              })}

              {extraToolsets.map((toolset) => {
                const enriched = enrichWithCatalog(toolset, toolsetOptions);
                return (
                  <AttachedToolsetCard
                    key={enriched.id}
                    toolset={enriched}
                    title="Toolset"
                    onConfigure={() => handleConfigureToolset(enriched, null)}
                    onDelete={() => removeExtraToolset(enriched.id)}
                  />
                );
              })}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="medium"
            label="Add toolset"
            icon={<IconPlus size={16} />}
            className="agent-form__add-resource"
            onClick={handleOpenToolsetAdd}
          />
        </div>
      </section>

      <KnowledgeBaseConfigDialog
        open={kbDialogOpen}
        draft={kbDraft}
        knowledgeBases={kbOptions}
        onClose={() => {
          setKbDialogOpen(false);
          setEditingKbId(null);
          setPendingKbRequirementId(null);
        }}
        onDraftChange={(next) => setKbDraft((prev) => ({ ...prev, ...next }))}
        onSave={handleSaveKb}
      />

      <ToolsetConfigDialog
        open={toolsetDialogOpen}
        draft={toolsetDraft}
        toolsets={enrichedToolsetOptions}
        toolsLoading={toolsLoading}
        toolsError={toolsError}
        onClose={() => {
          setToolsetDialogOpen(false);
          setEditingToolsetId(null);
          setPendingToolRequirementId(null);
        }}
        onDraftChange={(next) => setToolsetDraft((prev) => ({ ...prev, ...next }))}
        onSave={handleSaveToolset}
      />
    </>
  );
}

export { TemplateAgentRequirementsSection };
export type { TemplateAgentRequirementsSectionProps };
