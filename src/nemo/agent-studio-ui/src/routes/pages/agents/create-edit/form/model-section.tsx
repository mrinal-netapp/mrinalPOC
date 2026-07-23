import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useStore } from "@tanstack/react-store";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useListProjectModelsQuery } from "@/routes/pages/agents/api/agents-config-api.slice";
import type { ProjectModelSummary } from "@/routes/pages/agents/api/agents-config.types";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { SelectDropdownField } from "@/ui-lib/base-components/form/form-field.select-dropdown";
import { SliderField } from "@/ui-lib/base-components/form/form-field.slider";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { agentFormFieldPath, getFormValueAtPath } from "./agent-form-field-path";
import { TemplateRequiredLabel } from "./template-required-label";

interface ModelSectionProps {
  form: AnyReactFormApi;
  primaryModelError?: string;
  /** When set, model fields are read/written under this nested form prefix. */
  fieldPrefix?: string;
  /** Shown to the right of the primary model label in template import mode. */
  recommendedModel?: string;
  /** Shows a red *required marker until a primary model is selected. */
  showPrimaryModelRequired?: boolean;
  /** Hide the outer section heading when nested inside a template agent card. */
  showSectionHeader?: boolean;
  /** When false, hides temperature / top-p / response length controls. */
  showModelParams?: boolean;
}

type ModelOption = {
  key: string;
  value: string;
  label: string;
};

// The picker stores the model's UUID (`id`) as the agent's `modelId`. The
// label prefers the human-friendly `displayName`, falling back to `name`.
function toModelOption(model: ProjectModelSummary): ModelOption {
  return {
    key: model.id,
    value: model.id,
    label: model.displayName ?? model.name ?? model.id,
  };
}

// Collapsed by default to match the Figma "Temperature, Top-p, response length" link.
function ModelParamsCollapsible({
  form,
  group,
  responseLengthLabel,
}: {
  form: AnyReactFormApi;
  group: string;
  responseLengthLabel: string;
}): ReactElement {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="agent-form__params-toggle"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((v) => !v)}
      >
        Temperature, Top-p, {responseLengthLabel.toLowerCase()}
        {isOpen ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
      </button>

      {isOpen && (
        <div className="agent-form__params">
          <SliderField
            form={form}
            name={`${group}.temperature`}
            label="Temperature"
            min={0}
            max={2}
            step={0.1}
            isShowCurrent
            isEditInput
            isShowLimits
          />
          <SliderField
            form={form}
            name={`${group}.topP`}
            label="Top-p"
            min={0}
            max={1}
            step={0.05}
            isShowCurrent
            isEditInput
            isShowLimits
          />
          <SliderField
            form={form}
            name={`${group}.responseLength`}
            label={responseLengthLabel}
            min={1}
            max={8192}
            step={1}
            isShowCurrent
            isEditInput
            isShowLimits
          />
        </div>
      )}
    </>
  );
}

function ModelSection({
  form,
  primaryModelError,
  fieldPrefix,
  recommendedModel,
  showPrimaryModelRequired = false,
  showSectionHeader = true,
  showModelParams = true,
}: ModelSectionProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const primaryModelField = agentFormFieldPath(fieldPrefix, "primaryModel");
  const fallbackModelField = agentFormFieldPath(fieldPrefix, "fallbackModel");
  const primaryModelParamsField = agentFormFieldPath(fieldPrefix, "primaryModelParams");
  const fallbackModelParamsField = agentFormFieldPath(fieldPrefix, "fallbackModelParams");

  // Only LLM models can back an agent; embedding models are filtered out by
  // the `modelType` query param.
  const { data: models, isLoading, isError } = useListProjectModelsQuery(
    { projectId, modelType: "llm" },
    { skip: !projectId },
  );

  const modelOptions = useMemo<ModelOption[]>(
    () => (models ?? []).map(toModelOption),
    [models],
  );

  // The model chosen as primary can't also be a fallback, so drop it from
  // the fallback dropdown's options.
  const primaryModel = useStore(
    form.store,
    (s) => getFormValueAtPath<string>(s.values, primaryModelField) ?? "",
  );
  const fallbackModel = useStore(
    form.store,
    (s) => getFormValueAtPath<string>(s.values, fallbackModelField) ?? "",
  );

  const fallbackModelOptions = useMemo<ModelOption[]>(
    () => modelOptions.filter((option) => option.value !== primaryModel),
    [modelOptions, primaryModel],
  );

  // If the fallback currently holds the model just selected as primary, clear
  // it — otherwise the field would show a selection that's no longer offered.
  useEffect(() => {
    if (primaryModel && fallbackModel === primaryModel) {
      form.setFieldValue(fallbackModelField, "");
    }
  }, [form, primaryModel, fallbackModel, fallbackModelField]);

  const placeholder = isLoading
    ? "Loading models…"
    : isError
      ? "Failed to load models"
      : modelOptions.length === 0
        ? "No models available"
        : "Select primary model";

  const fallbackPlaceholder = isLoading
    ? "Loading models…"
    : isError
      ? "Failed to load models"
      : modelOptions.length === 0
        ? "No models available"
        : "Select fallback model";

  return (
    <section className="agent-form__section">
      {showSectionHeader && (
        <div className="agent-form__section-header">
          <Typography
            Component="h2"
            fontSize="fs16"
            boldness="semibold"
            className="agent-form__section-title"
          >
            Model
          </Typography>
        </div>
      )}

      <div className="agent-form__section-body">
        <div className="agent-form__field">
          {recommendedModel ? (
            <div className="agent-form__field-label-row">
              <span className="agent-form__template-requirement-row-title">
                <Typography fontSize="fs14" boldness="semibold">
                  Primary model
                </Typography>
                {showPrimaryModelRequired && !primaryModel.trim() ? (
                  <TemplateRequiredLabel />
                ) : null}
              </span>
              <Typography
                fontSize="fs13"
                color="var(--text-secondary)"
                className="agent-form__recommended-model-label"
              >
                Recommended model is {recommendedModel}
              </Typography>
            </div>
          ) : null}
          <SelectDropdownField
            form={form}
            name={primaryModelField}
            label={recommendedModel ? undefined : "Primary model"}
            items={modelOptions}
            placeholder={placeholder}
            size="fill"
            isDisabled={isLoading || isError}
          />
          {showModelParams && (
            <ModelParamsCollapsible
              form={form}
              group={primaryModelParamsField as "primaryModelParams" | "fallbackModelParams"}
              responseLengthLabel="Response length"
            />
          )}
          {primaryModelError && (
            <Typography
              Component="p"
              fontSize="fs13"
              color="var(--notification-error)"
              className="agent-form__inline-error"
            >
              {primaryModelError}
            </Typography>
          )}
        </div>

        <div className="agent-form__field">
          <SelectDropdownField
            form={form}
            name={fallbackModelField}
            label="Fallback model"
            isOptional
            items={fallbackModelOptions}
            placeholder={fallbackPlaceholder}
            size="fill"
            isDisabled={isLoading || isError}
            options={{ isClearable: true, isSearchable: true }}
          />
          {showModelParams && (
            <ModelParamsCollapsible
              form={form}
              group={fallbackModelParamsField as "primaryModelParams" | "fallbackModelParams"}
              responseLengthLabel="Maximum response length"
            />
          )}
        </div>
      </div>
    </section>
  );
}

export { ModelSection };
export type { ModelSectionProps };
