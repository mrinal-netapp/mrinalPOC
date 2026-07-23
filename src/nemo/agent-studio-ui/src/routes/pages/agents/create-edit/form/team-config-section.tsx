import { useId, useMemo, useState, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";
import { IconChevronDown, IconChevronUp, IconInfoCircle } from "@tabler/icons-react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useListProjectModelsQuery } from "@/routes/pages/agents/api/agents-config-api.slice";
import type { ProjectModelSummary } from "@/routes/pages/agents/api/agents-config.types";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import { InputField } from "@/ui-lib/base-components/form/form-field.input";
import { agentNamePatternError } from "./agent-form.consts";
import { SliderField } from "@/ui-lib/base-components/form/form-field.slider";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import {
  AGENT_ORCHESTRATION_OPTIONS,
  TEAM_MAX_ITERATIONS_MAX,
  TEAM_MAX_ITERATIONS_MIN,
  TEAM_TERMINATION_STRATEGY_OPTIONS,
} from "./agent-form.consts";

interface ModelOption {
  key: string;
  value: string;
  label: string;
}

function toModelOption(model: ProjectModelSummary): ModelOption {
  return { key: model.id, value: model.id, label: model.name };
}

interface TeamConfigSectionProps {
  form: AnyReactFormApi;
}

/**
 * Coordinate-only termination controls, collapsed by default to mirror the
 * Model section's "Temperature, Top-p, response length" disclosure. Exposes the
 * (currently single-option) termination strategy plus the max-iterations cap
 * that the planner stops at. Maps to `terminationStrategy.maximum_iterations`.
 */
function TerminationStrategyCollapsible({ form }: { form: AnyReactFormApi }): ReactElement {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="agent-form__field">
      <button
        type="button"
        className="agent-form__params-toggle"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((v) => !v)}
      >
        Termination strategy, maximum iterations
        {isOpen ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
      </button>

      {isOpen && (
        <div className="agent-form__params">
          <SelectDropdownField
            form={form}
            name="team.terminationStrategyType"
            label="Termination strategy"
            items={TEAM_TERMINATION_STRATEGY_OPTIONS}
            placeholder="Select termination strategy"
            size="fill"
          />
          <SliderField
            form={form}
            name="team.maxIterations"
            label="Maximum iterations"
            min={TEAM_MAX_ITERATIONS_MIN}
            max={TEAM_MAX_ITERATIONS_MAX}
            step={1}
            isShowCurrent
            isEditInput
            isShowLimits
          />
        </div>
      )}
    </div>
  );
}

function TeamConfigSection({ form }: TeamConfigSectionProps): ReactElement {
  const orchestrationPattern = useStore(
    form.store,
    (s: { values: { team: { orchestrationPattern: string } } }) =>
      s.values.team.orchestrationPattern,
  );

  const managerInstructions = useStore(
    form.store,
    (s: { values: { team: { managerInstructions: string } } }) =>
      s.values.team.managerInstructions,
  );

  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: models, isLoading: modelsLoading, isError: modelsError } = useListProjectModelsQuery(
    { projectId, modelType: "llm" },
    { skip: !projectId },
  );

  const modelOptions = useMemo<ModelOption[]>(
    () => (models ?? []).map(toModelOption),
    [models],
  );

  const modelPlaceholder = modelsLoading
    ? "Loading models…"
    : modelsError
      ? "Failed to load models"
      : modelOptions.length === 0
        ? "No models available"
        : "Select a model";

  // The manager block drives Magentic's autonomous planner ("coordinate") AND
  // triage's start-agent / router ("route"). Both orchestrations need name,
  // model, and instructions on the manager record; without them the backend
  // either falls back to defaults (coordinate) or skips the manager-driven
  // routing entirely and uses the first member as the router (route).
  const requiresManager =
    orchestrationPattern === "coordinate" || orchestrationPattern === "route";
  const instructionsFieldId = useId();

  return (
    <section className="agent-form__section">
      <div className="agent-form__section-header">
        <Typography
          Component="h2"
          fontSize="fs16"
          boldness="semibold"
          className="agent-form__section-title"
        >
          Configuration
        </Typography>
      </div>

      <div className="agent-form__section-body">
        <div className="agent-form__field">
          <SelectDropdownField
            form={form}
            name="team.orchestrationPattern"
            label="Orchestration pattern"
            items={AGENT_ORCHESTRATION_OPTIONS}
            placeholder="Select orchestration pattern"
            size="fill"
          />
        </div>

        {requiresManager && (
          <div className="agent-form__section agent-form__section--nested">
            <div className="agent-form__section-header agent-form__section-header--stacked">
              <Typography
                Component="h3"
                fontSize="fs14"
                boldness="semibold"
                className="agent-form__section-title"
              >
                Manager agent
              </Typography>
              <Typography fontSize="fs13" color="var(--text-secondary)">
                {orchestrationPattern === "route"
                  ? "Configures the router agent that decides which team member handles each user message."
                  : "Configures the agent that coordinates the team members."}
              </Typography>
            </div>

            <div className="agent-form__field">
              <InputField
                form={form}
                name="team.managerName"
                label="Manager name"
                placeholder="Name this manager agent"
                validators={{
                  onChange: ({ value }: { value: string }) =>
                    agentNamePatternError(value ?? ""),
                  onBlur: ({ value }: { value: string }) =>
                    agentNamePatternError(value ?? ""),
                }}
              />
            </div>

            <div className="agent-form__field">
              <SelectDropdownField
                form={form}
                name="team.managerModel"
                label="Model"
                items={modelOptions}
                placeholder={modelPlaceholder}
                size="fill"
                isDisabled={modelsLoading || modelsError}
                options={{ isClearable: true, isSearchable: true }}
              />
            </div>

            <div className="agent-form__field agent-form__textarea-wrapper">
              <label htmlFor={instructionsFieldId}>
                <Typography fontSize="fs14" boldness="semibold">
                  Instructions
                </Typography>
              </label>
              <form.Field name="team.managerInstructions">
                {(field) => (
                  <textarea
                    id={instructionsFieldId}
                    className="agent-form__textarea"
                    value={field.state.value as string}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    placeholder={
                      orchestrationPattern === "route"
                        ? "Describe routing rules: which specialist to pick for which kind of user message."
                        : "Describe the manager agent's tone, constraints, and coordination strategy."
                    }
                    rows={6}
                  />
                )}
              </form.Field>
              {managerInstructions.length > 0 && (
                <div className="agent-form__textarea-meta">
                  {managerInstructions.length} characters
                </div>
              )}
            </div>

            {/* Termination strategy is a Coordinate-only (Magentic planner) concern;
                Route (triage) terminates on the router's handoff, not an iteration cap. */}
            {orchestrationPattern === "coordinate" && (
              <TerminationStrategyCollapsible form={form} />
            )}
          </div>
        )}

        <div className="agent-form__inline-notice">
          <IconInfoCircle size={16} className="agent-form__inline-notice-icon" aria-hidden="true" />
          <Typography fontSize="fs14" color="var(--text-secondary)">
            Add at least one to continue: a single agent or a team agent.
          </Typography>
        </div>
      </div>
    </section>
  );
}

export { TeamConfigSection, TerminationStrategyCollapsible };
export type { TeamConfigSectionProps };
