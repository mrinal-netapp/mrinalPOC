import type { ReactElement } from "react";
import { useStore } from "@tanstack/react-store";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { AgentSubEntityCard } from "./agent-sub-entity-card";
import { useTeamAgentOptions } from "./use-team-member-options";

interface TeamAgentsSectionProps {
  form: AnyReactFormApi;
  /** Renders the section header. Set false when nested under another heading. */
  showHeader?: boolean;
  /** Section heading text (when shown). */
  heading?: string;
}

function TeamAgentsSection({
  form,
  showHeader = true,
  heading = "Agents",
}: TeamAgentsSectionProps): ReactElement {
  const selectedIds: string[] = useStore(
    form.store,
    (s: { values: { team: { agentIds: string[] } } }) => s.values.team.agentIds,
  );

  const { entities, items: agentItems, isLoading, isError } = useTeamAgentOptions();
  const selectedAgents = entities.filter((a) => selectedIds.includes(a.id));

  const placeholder = isLoading
    ? "Loading agents…"
    : isError
      ? "Failed to load agents"
      : entities.length === 0
        ? "No agents available"
        : "Select agents";

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
            {heading}
          </Typography>
        </div>
      )}

      <div className="agent-form__section-body">
        <div className="agent-form__field">
          <SelectDropdownField
            form={form}
            name="team.agentIds"
            items={agentItems}
            placeholder={placeholder}
            size="fill"
            isDisabled={isLoading || isError}
            options={{
              isMultiSelect: true,
              isChipDisplay: true,
              isClearable: true,
              isSearchable: true,
            }}
          />
        </div>

        {selectedAgents.length > 0 && (
          <div className="agent-form__sub-entity-list">
            {selectedAgents.map((agent) => (
              <AgentSubEntityCard key={agent.id} entity={agent} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export { TeamAgentsSection };
export type { TeamAgentsSectionProps };
