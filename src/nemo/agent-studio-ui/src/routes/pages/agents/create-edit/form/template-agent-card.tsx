import { useCallback, useState, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";
import {
  IconAlertTriangle,
  IconBox,
  IconCircleCheck,
  IconDots,
  IconExternalLink,
} from "@tabler/icons-react";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { InputField } from "@/ui-lib/base-components/form/form-field.input";
import { Button } from "@/ui-lib/base-components/button/button";
import { Card } from "@/ui-lib/base-components/card/card";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ROUTES } from "@/routes/routes.consts";
import { getAppBasePath } from "@/consts/app-base-path";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";

import { TemplateAgentConfigDialog } from "../configure-dialogs/template-agent-config-dialog/template-agent-config-dialog";
import type {
  AgentTemplateAgentDefinition,
  AgentTemplateResourceRequirement,
} from "./agent-templates.consts";
import type { AgentTemplateAgentInstanceValues } from "./agent-form.consts";
import { NAME_MAX_LENGTH, NAME_PLACEHOLDER } from "./agent-form.consts";
import { agentFormFieldPath, getFormValueAtPath } from "./agent-form-field-path";
import {
  activeKbRequirements,
  activeMcpRequirements,
  deriveTemplateAgentSummary,
  isKbRequirementConfigured,
  isMcpRequirementConfigured,
  isTemplateAgentConfigured,
  type TemplateAgentFieldErrors,
} from "./template-agent.utils";

interface TemplateAgentCardProps {
  form: AnyReactFormApi;
  fieldPrefix: string;
  agentDefinition: AgentTemplateAgentDefinition;
  recommendedModel?: string;
  validationErrors?: TemplateAgentFieldErrors;
  withSidePane?: boolean;
  /** Card title (e.g. "Manager agent" / "Single agent"). Defaults to the agent name. */
  headerLabel?: string;
  /** Small subtitle under the title (e.g. "Optional"). */
  subtitle?: string;
  /** Hide KB / toolset rows + configuration (used by the manager agent). */
  hideResources?: boolean;
  /** When provided, the card's "…" menu shows a Remove action. */
  onRemove?: () => void;
}

/** Renders a value cell as a stacked list of resource links, or an em dash. */
function toAppHref(path: string): string {
  return `${getAppBasePath()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Renders the still-unconfigured requirements the user needs to add for this agent. */
function PendingRequirementsList({
  requirements,
}: {
  requirements: AgentTemplateResourceRequirement[];
}): ReactElement | null {
  if (requirements.length === 0) {
    return null;
  }
  return (
    <span className="agent-form__template-pending-list">
      {requirements.map((requirement) => (
        <span
          key={requirement.id}
          className="agent-form__profile-status-warning agent-form__template-pending-item"
          title={requirement.description || undefined}
        >
          <IconAlertTriangle size={14} aria-hidden="true" />
          <Typography fontSize="fs14">
            {requirement.label}
            {requirement.required ? "" : " (optional)"}
          </Typography>
        </span>
      ))}
    </span>
  );
}

function ResourceLinkList({
  items,
  baseRoute,
}: {
  items: { id: string; name: string }[];
  baseRoute: string;
}): ReactElement | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <span className="agent-form__template-resource-links">
      {items.map((item) => (
        <span key={item.id} className="agent-form__sub-entity-name">
          <Typography fontSize="fs14" color="var(--primary-main, var(--link-primary, #0d6efd))">
            {item.name}
          </Typography>
          <a
            href={toAppHref(`/${baseRoute}/${item.id}`)}
            target="_blank"
            rel="noreferrer"
            className="agent-form__resource-icon-link"
            aria-label={`Open ${item.name} in a new tab`}
          >
            <IconExternalLink size={14} aria-hidden="true" />
          </a>
        </span>
      ))}
    </span>
  );
}

/**
 * Combines attached resources with the still-unconfigured requirements for
 * a given row (Knowledge base / Toolsets), so the card shows both what's
 * already added and what the template still expects. Falls back to an em
 * dash only when there's nothing attached and nothing outstanding.
 */
function ResourceRequirementCell({
  attached,
  pending,
  baseRoute,
}: {
  attached: { id: string; name: string }[];
  pending: AgentTemplateResourceRequirement[];
  baseRoute: string;
}): ReactElement {
  if (attached.length === 0 && pending.length === 0) {
    return <Typography fontSize="fs14">—</Typography>;
  }
  return (
    <span className="agent-form__template-resource-cell">
      <ResourceLinkList items={attached} baseRoute={baseRoute} />
      <PendingRequirementsList requirements={pending} />
    </span>
  );
}

function TemplateAgentCard({
  form,
  fieldPrefix,
  agentDefinition,
  recommendedModel,
  validationErrors,
  withSidePane = false,
  headerLabel,
  subtitle,
  hideResources = false,
  onRemove,
}: TemplateAgentCardProps): ReactElement {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const instance = useStore(form.store, (s) =>
    getFormValueAtPath<AgentTemplateAgentInstanceValues>(s.values, fieldPrefix),
  );
  const nameFieldPath = agentFormFieldPath(fieldPrefix, "name");
  const summary = deriveTemplateAgentSummary(agentDefinition, instance);
  // Member cards share the generic header "Single agent"; use catalog name so
  // screen readers can tell name fields apart when several cards are visible.
  const nameFieldAriaLabel = `Agent name for ${
    headerLabel && headerLabel !== "Single agent" ? headerLabel : agentDefinition.name
  }`;

  // Status reflects whether every required field is set: "Not configured"
  // until then, "Ready to deploy" once complete.
  const isConfigured = isTemplateAgentConfigured(agentDefinition, instance);

  const kbItems = (instance?.knowledgeBases ?? []).map((kb) => ({ id: kb.id, name: kb.name }));
  const toolItems = (instance?.toolsets ?? []).map((toolset) => ({
    id: toolset.id,
    name: toolset.name,
  }));

  // Requirements the template calls for that this agent has not attached yet;
  // surfaced directly on the summary card so the user knows what to add
  // before opening Configure.
  const pendingKbRequirements = instance
    ? activeKbRequirements(agentDefinition.requirements, instance).filter(
        (req) => !isKbRequirementConfigured(req.id, instance),
      )
    : agentDefinition.requirements.knowledgeBases;
  const pendingMcpRequirements = instance
    ? activeMcpRequirements(agentDefinition.requirements, instance).filter(
        (req) => !isMcpRequirementConfigured(req.id, instance),
      )
    : agentDefinition.requirements.mcpServers;

  const handleOpen = useCallback(() => {
    setIsDialogOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsDialogOpen(false);
  }, []);

  const handleSave = useCallback(() => {
    setIsDialogOpen(false);
  }, []);

  return (
    <>
      <Card className="agent-form__template-agent-summary-card">
        <div className="agent-form__template-agent-summary-header">
          <div className="agent-form__feature-card-title-row">
            <span className="agent-form__feature-card-icon" aria-hidden="true">
              <IconBox size={16} />
            </span>
            <span className="agent-form__template-agent-title">
              <Typography fontSize="fs14" boldness="semibold">
                {headerLabel ?? summary.name}
              </Typography>
              {subtitle && (
                <Typography fontSize="fs12" color="var(--text-secondary)">
                  {subtitle}
                </Typography>
              )}
            </span>
          </div>
          <div className="agent-form__template-agent-actions">
            <button
              type="button"
              className="agent-form__resource-link-button"
              onClick={handleOpen}
            >
              Configure
            </button>
            {onRemove && (
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
            )}
          </div>
        </div>

        <div className="agent-form__resource-body">
          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Name
          </Typography>
          <div className="agent-form__template-agent-name-field">
            <InputField
              form={form}
              name={nameFieldPath}
              aria-label={nameFieldAriaLabel}
              placeholder={NAME_PLACEHOLDER}
              maxLength={NAME_MAX_LENGTH}
              warning={validationErrors?.name}
            />
          </div>

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Status
          </Typography>
          {isConfigured ? (
            <span className="agent-form__status">
              <IconCircleCheck
                size={16}
                className="agent-form__status-icon--healthy"
                aria-hidden="true"
              />
              <Typography fontSize="fs14">Ready to deploy</Typography>
            </span>
          ) : (
            <span className="agent-form__profile-status-warning">
              <IconAlertTriangle size={16} aria-hidden="true" />
              <Typography fontSize="fs14">Not configured</Typography>
            </span>
          )}

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Deployment
          </Typography>
          <Typography fontSize="fs14">Not deployed</Typography>

          {!hideResources && (
            <>
              <Typography fontSize="fs14" className="agent-form__resource-row-label">
                Knowledge base
              </Typography>
              <ResourceRequirementCell
                attached={kbItems}
                pending={pendingKbRequirements}
                baseRoute={ROUTES.KNOWLEDGE_BASES}
              />

              <Typography fontSize="fs14" className="agent-form__resource-row-label">
                Toolsets
              </Typography>
              <ResourceRequirementCell
                attached={toolItems}
                pending={pendingMcpRequirements}
                baseRoute={ROUTES.TOOLSET}
              />
            </>
          )}

          {!hideResources && (
            <>
              <Typography fontSize="fs14" className="agent-form__resource-row-label">
                Description
              </Typography>
              <Typography fontSize="fs14">
                {instance?.description?.trim() ? instance.description : "—"}
              </Typography>
            </>
          )}

          <Typography fontSize="fs14" className="agent-form__resource-row-label">
            Role
          </Typography>
          <Typography fontSize="fs14">
            {summary.role ? summary.role : "—"}
          </Typography>
        </div>
      </Card>

      <TemplateAgentConfigDialog
        open={isDialogOpen}
        form={form}
        fieldPrefix={fieldPrefix}
        agentDefinition={agentDefinition}
        recommendedModel={recommendedModel}
        validationErrors={validationErrors}
        withSidePane={withSidePane}
        hideResources={hideResources}
        subtitle={headerLabel}
        onClose={handleClose}
        onSave={handleSave}
      />
    </>
  );
}

export { TemplateAgentCard };
export type { TemplateAgentCardProps };
