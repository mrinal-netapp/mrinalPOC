import type { ReactElement } from "react";
import { useStore } from "@tanstack/react-store";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { AgentSubEntityCard } from "./agent-sub-entity-card";
import { useTeamTeamOptions } from "./use-team-member-options";

interface TeamTeamsSectionProps {
  form: AnyReactFormApi;
  /**
   * Id of the team currently being edited (or just created and saved as draft).
   * A team can't be a member of itself, so it is removed from the picker. In
   * create mode (before the first save) this is undefined and nothing is hidden.
   */
  currentTeamId?: string;
  /** Renders the section header. Set false when nested under another heading. */
  showHeader?: boolean;
  /** Section heading text (when shown). */
  heading?: string;
}

function TeamTeamsSection({
  form,
  currentTeamId,
  showHeader = true,
  heading = "Teams",
}: TeamTeamsSectionProps): ReactElement {
  const selectedIds: string[] = useStore(
    form.store,
    (s: { values: { team: { teamIds: string[] } } }) => s.values.team.teamIds,
  );

  const { entities, items, isLoading, isError } = useTeamTeamOptions();
  // Drop the current team so it can't be added as a member of itself.
  const teamItems = currentTeamId
    ? items.filter((item) => item.value !== currentTeamId)
    : items;
  const selectedTeams = entities.filter(
    (t) => selectedIds.includes(t.id) && t.id !== currentTeamId,
  );

  const placeholder = isLoading
    ? "Loading teams…"
    : isError
      ? "Failed to load teams"
      : entities.length === 0
        ? "No teams available"
        : "Select teams";

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
            name="team.teamIds"
            items={teamItems}
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

        {selectedTeams.length > 0 && (
          <div className="agent-form__sub-entity-list">
            {selectedTeams.map((team) => (
              <AgentSubEntityCard key={team.id} entity={team} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export { TeamTeamsSection };
export type { TeamTeamsSectionProps };
