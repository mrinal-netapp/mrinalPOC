import { useCallback, useState, type ReactElement } from "react";
import { IconChevronDown, IconChevronUp, IconBox, IconDots } from "@tabler/icons-react";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form";
import { Card } from "@/ui-lib/base-components/card/card";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";

import { StructuredOutputConfigDialog } from "../configure-dialogs/structured-output-config-dialog";
import { ConversationMemoryConfigDialog } from "../configure-dialogs/conversation-memory-config-dialog";
import { SafetyGuardrailsConfigDialog } from "../configure-dialogs/safety-guardrails-config-dialog";
import { AutomaticRetriesConfigDialog } from "../configure-dialogs/automatic-retries-config-dialog";
import { AgentRateLimitingConfigDialog } from "../configure-dialogs/agent-rate-limiting-config-dialog";
import {
  DEFAULT_AGENT_RATE_LIMITING_CONFIG,
  DEFAULT_AUTOMATIC_RETRIES_CONFIG,
  DEFAULT_CONVERSATION_MEMORY_CONFIG,
  DEFAULT_SAFETY_GUARDRAILS_CONFIG,
  DEFAULT_STRUCTURED_OUTPUT_CONFIG,
} from "../configure-dialogs/configure-dialogs.consts";
import type {
  AgentRateLimitingConfig,
  AutomaticRetriesConfig,
  ConversationMemoryConfig,
  SafetyGuardrailsConfig,
  StructuredOutputConfig,
} from "../configure-dialogs/configure-dialogs.types";

import {
  AGENT_FEATURE_LIST,
  buildFeatureBody,
  resetFeatureConfig,
  DEFAULT_FEATURE_CONFIG,
  type AgentConfigurationFeature,
  type AgentFeatureKey,
  type AgentFeatureMeta,
} from "./agent-form.consts";
import { agentFormFieldPath, getFormValueAtPath } from "./agent-form-field-path";

interface ConfigurationSectionProps {
  form: AnyReactFormApi;
  fieldPrefix?: string;
  showSectionHeader?: boolean;
  structuredOutputError?: string;
}

// Drafts for every dialog this section opens. We keep them all mounted in
// state so reopening a dialog after Save → Cancel restores the user's
// last-typed values.
type FeatureDrafts = {
  structured_output: StructuredOutputConfig;
  conversation_memory: ConversationMemoryConfig;
  safety_guardrails: SafetyGuardrailsConfig;
  automatic_retries: AutomaticRetriesConfig;
  api_rate_limiting: AgentRateLimitingConfig;
};

const DEFAULT_FEATURE_DRAFTS: FeatureDrafts = {
  structured_output: DEFAULT_STRUCTURED_OUTPUT_CONFIG,
  conversation_memory: DEFAULT_CONVERSATION_MEMORY_CONFIG,
  safety_guardrails: DEFAULT_SAFETY_GUARDRAILS_CONFIG,
  automatic_retries: DEFAULT_AUTOMATIC_RETRIES_CONFIG,
  api_rate_limiting: DEFAULT_AGENT_RATE_LIMITING_CONFIG,
};

// Maps a feature key to its companion dialog. Feature keys not present
// in `DEFAULT_FEATURE_DRAFTS` have no dialog and are treated as no-ops.
type FeatureKeyWithDialog = keyof FeatureDrafts;

function isFeatureKeyWithDialog(key: AgentFeatureKey): key is FeatureKeyWithDialog {
  return key in DEFAULT_FEATURE_DRAFTS;
}

function buildInitialDraftsFromSlice(values: {
  enabledFeatures: AgentFeatureKey[];
  featureConfig: AgentConfigurationFeature;
}): FeatureDrafts {
  const fc = values.featureConfig;
  const isOn = (key: AgentFeatureKey): boolean => values.enabledFeatures.includes(key);
  return {
    structured_output: {
      ...DEFAULT_FEATURE_DRAFTS.structured_output,
      enabled: isOn("structured_output"),
      responseFormat: fc.responseFormat,
      schema: fc.structuredOutputSchema,
    },
    conversation_memory: {
      ...DEFAULT_FEATURE_DRAFTS.conversation_memory,
      retentionMethod: fc.messageRetentionMethod,
      messageHistoryLimit: fc.messageHistoryLimit,
      sessionHistoryLimit: fc.sessionHistoryLimit,
      summaryTokenLimit: fc.summaryTokenLimit,
    },
    safety_guardrails: {
      piiMaskerEnabled: fc.piiMaskerEnabled,
      apiKeyTokenScannerEnabled: fc.apiKeyTokenScannerEnabled,
      secretDetectionEnabled: fc.secretDetectionEnabled,
    },
    automatic_retries: {
      ...DEFAULT_FEATURE_DRAFTS.automatic_retries,
      enabled: isOn("automatic_retries"),
      maxRetries: fc.maxRetries,
    },
    api_rate_limiting: {
      ...DEFAULT_FEATURE_DRAFTS.api_rate_limiting,
      enabled: isOn("api_rate_limiting"),
      maxRequestsPerMinute: fc.maxRequestsPerMinute,
    },
  };
}

function FeatureCard({
  meta,
  enabled,
  config,
  onConfigure,
  onToggle,
  errorMessage,
}: {
  meta: AgentFeatureMeta;
  enabled: boolean;
  config: AgentConfigurationFeature;
  onConfigure?: () => void;
  onToggle?: (next: boolean) => void;
  errorMessage?: string;
}): ReactElement {
  const rows = buildFeatureBody(meta.key, enabled, config);

  return (
    <Card>
      <div className="agent-form__feature-card-header">
        <div className="agent-form__feature-card-title-row">
          <span className="agent-form__feature-card-icon" aria-hidden="true">
            <IconBox size={16} />
          </span>
          <Typography fontSize="fs14" boldness="semibold">
            {meta.title}
          </Typography>
        </div>
        <div className="agent-form__feature-card-actions">
          <button
            type="button"
            className="agent-form__resource-link-button"
            onClick={
              meta.actionWhenEnabled === "Configure" || enabled
                ? onConfigure
                : () => onToggle?.(true)
            }
          >
            {!enabled && meta.actionWhenEnabled === "Enable" ? "Enable" : "Configure"}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="agent-form__resource-card-menu-trigger"
              aria-label={`${meta.title} options`}
            >
              <IconDots size={16} aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="end"
              sideOffset={8}
              className="agent-form__resource-card-menu-content"
            >
              {enabled ? (
                <DropdownMenuItem
                  onClick={() => onToggle?.(false)}
                  className="agent-form__resource-card-menu-item"
                >
                  <Typography Component="span" fontSize="fs14">Disable</Typography>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={() => onToggle?.(true)}
                  className="agent-form__resource-card-menu-item"
                >
                  <Typography Component="span" fontSize="fs14">Enable</Typography>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="agent-form__feature-card-body">
        {rows.map((row) => (
          <div key={row.label} style={{ display: "contents" }}>
            <Typography fontSize="fs14" className="agent-form__resource-row-label">
              {row.label}
            </Typography>
            <Typography fontSize="fs14">{row.value}</Typography>
          </div>
        ))}
      </div>
      {errorMessage && (
        <div style={{ marginTop: "8px" }}>
          <FormFieldErrorBlock message={errorMessage} />
        </div>
      )}
    </Card>
  );
}

function ConfigurationSection({
  form,
  fieldPrefix,
  showSectionHeader = true,
  structuredOutputError,
}: ConfigurationSectionProps): ReactElement {
  const enabledFeaturesField = agentFormFieldPath(fieldPrefix, "enabledFeatures");
  const featureConfigField = agentFormFieldPath(fieldPrefix, "featureConfig");

  const readFeatureSlice = useCallback(
    (values: unknown) => ({
      enabledFeatures:
        getFormValueAtPath<AgentFeatureKey[]>(values, enabledFeaturesField) ?? [],
      featureConfig:
        getFormValueAtPath<AgentConfigurationFeature>(values, featureConfigField) ??
        DEFAULT_FEATURE_CONFIG,
    }),
    [enabledFeaturesField, featureConfigField],
  );

  // Collapsed by default: the first two feature cards stay visible and the
  // rest are revealed via "Show more" (mockup).
  const [isExpanded, setIsExpanded] = useState(false);
  const COLLAPSED_FEATURE_COUNT = 2;
  const [activeDialog, setActiveDialog] = useState<FeatureKeyWithDialog | null>(null);
  const [drafts, setDrafts] = useState<FeatureDrafts>(() =>
    buildInitialDraftsFromSlice(readFeatureSlice(form.state.values)),
  );

  const handleOpenDialog = useCallback((key: AgentFeatureKey) => {
    if (isFeatureKeyWithDialog(key)) {
      if (key === "structured_output") {
        // Opening the configure flow for Structured output is an enable intent.
        // Keep the draft toggle on so the dialog enforces schema validation.
        setDrafts((prev) => ({
          ...prev,
          structured_output: { ...prev.structured_output, enabled: true },
        }));
      }
      setActiveDialog(key);
    }
  }, []);

  const handleCloseDialog = useCallback(() => {
    setActiveDialog(null);
  }, []);

  // Generic patch helper — narrows the patched key so only the matching
  // draft slot is updated.
  const patchDraft = useCallback(
    <K extends FeatureKeyWithDialog>(key: K, patch: Partial<FeatureDrafts[K]>) => {
      setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    },
    [],
  );

  const enableFeature = useCallback(
    (key: AgentFeatureKey) => {
      form.setFieldValue(enabledFeaturesField, (prev: AgentFeatureKey[]) =>
        prev.includes(key) ? prev : [...prev, key],
      );
    },
    [form, enabledFeaturesField],
  );

  const disableFeature = useCallback(
    (key: AgentFeatureKey) => {
      form.setFieldValue(enabledFeaturesField, (prev: AgentFeatureKey[]) =>
        prev.filter((k) => k !== key),
      );
    },
    [form, enabledFeaturesField],
  );

  // Switching a card off clears its configured values: reset the per-dialog
  // draft to defaults and roll the fields it owns in `featureConfig` back to
  // defaults so a disabled feature can't leak stale values into the payload.
  const resetFeature = useCallback(
    (key: AgentFeatureKey) => {
      if (isFeatureKeyWithDialog(key)) {
        setDrafts((prev) => ({ ...prev, [key]: DEFAULT_FEATURE_DRAFTS[key] }));
      }
      form.setFieldValue(featureConfigField, (prev: AgentConfigurationFeature) =>
        resetFeatureConfig(key, prev),
      );
    },
    [form, featureConfigField],
  );

  const handleToggle = useCallback(
    (key: AgentFeatureKey, next: boolean) => {
      if (next) {
        if (key === "structured_output") {
          // Structured output is only valid when a JSON schema is configured.
          // Route "enable" actions through the dialog instead of toggling on
          // directly so we never land in enabled-without-schema state.
          handleOpenDialog(key);
          return;
        }
        enableFeature(key);
      } else {
        disableFeature(key);
        resetFeature(key);
      }
    },
    [enableFeature, disableFeature, resetFeature, handleOpenDialog],
  );

  // Sync any cleanly-mappable dialog fields back into the form's
  // featureConfig so the feature card body reflects the saved values.
  // Drafts that don't map to featureConfig (output response, structured
  // output, rate limiting) live solely in the section's drafts state.
  const syncFeatureConfigOnSave = useCallback(
    (key: FeatureKeyWithDialog, draft: FeatureDrafts[FeatureKeyWithDialog]) => {
      form.setFieldValue(featureConfigField, (prev: AgentConfigurationFeature) => {
        const next = { ...prev };
        if (key === "safety_guardrails") {
          const d = draft as SafetyGuardrailsConfig;
          next.piiMaskerEnabled = d.piiMaskerEnabled;
          next.apiKeyTokenScannerEnabled = d.apiKeyTokenScannerEnabled;
          next.secretDetectionEnabled = d.secretDetectionEnabled;
        } else if (key === "conversation_memory") {
          const d = draft as ConversationMemoryConfig;
          next.messageRetentionMethod = d.retentionMethod;
          // No toggle gating any more — whatever value the user typed
          // in the dialog input is persisted directly. Dialog input
          // ranges enforce the bounds (1..200 for messages,
          // 64..50_000 for summary tokens), and the api-mapper writes
          // the field that matches the selected retention method.
          next.messageHistoryLimit = d.messageHistoryLimit;
          next.sessionHistoryLimit = d.sessionHistoryLimit;
          next.summaryTokenLimit = d.summaryTokenLimit;
        } else if (key === "automatic_retries") {
          const d = draft as AutomaticRetriesConfig;
          next.maxRetries = d.maxRetries;
        } else if (key === "structured_output") {
          const d = draft as StructuredOutputConfig;
          next.responseFormat = d.responseFormat;
          next.structuredOutputSchema = d.schema;
        } else if (key === "api_rate_limiting") {
          const d = draft as AgentRateLimitingConfig;
          next.maxRequestsPerMinute = d.maxRequestsPerMinute;
        }
        return next;
      });
    },
    [form, featureConfigField],
  );

  const handleSaveDialog = useCallback(() => {
    if (!activeDialog) return;
    enableFeature(activeDialog);
    syncFeatureConfigOnSave(activeDialog, drafts[activeDialog]);
    setActiveDialog(null);
  }, [activeDialog, drafts, enableFeature, syncFeatureConfigOnSave]);

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
            Configuration
          </Typography>
        </div>
      )}

      <div className="agent-form__section-body">
        <form.Subscribe
          selector={(state: { values: unknown }) => readFeatureSlice(state.values)}
        >
          {({
            enabledFeatures,
            featureConfig,
          }: {
            enabledFeatures: AgentFeatureKey[];
            featureConfig: AgentConfigurationFeature;
          }) => {
            const visibleFeatures = isExpanded
              ? AGENT_FEATURE_LIST
              : AGENT_FEATURE_LIST.slice(0, COLLAPSED_FEATURE_COUNT);
            return (
              <div className="agent-form__feature-list">
                {visibleFeatures.map((meta) => {
                  const enabled = enabledFeatures.includes(meta.key);
                  return (
                    <FeatureCard
                      key={meta.key}
                      meta={meta}
                      enabled={enabled}
                      config={featureConfig}
                      onConfigure={() => handleOpenDialog(meta.key)}
                      onToggle={(next) => handleToggle(meta.key, next)}
                      errorMessage={
                        meta.key === "structured_output"
                          ? structuredOutputError
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            );
          }}
        </form.Subscribe>
      </div>

      {AGENT_FEATURE_LIST.length > COLLAPSED_FEATURE_COUNT && (
        <button
          type="button"
          className="agent-form__feature-show-toggle"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((v) => !v)}
        >
          {isExpanded ? (
            <>
              Show less <IconChevronUp size={16} />
            </>
          ) : (
            <>
              Show more <IconChevronDown size={16} />
            </>
          )}
        </button>
      )}

      <StructuredOutputConfigDialog
        open={activeDialog === "structured_output"}
        draft={drafts.structured_output}
        onClose={handleCloseDialog}
        onDraftChange={(next) => patchDraft("structured_output", next)}
        onSave={handleSaveDialog}
      />
      <ConversationMemoryConfigDialog
        open={activeDialog === "conversation_memory"}
        draft={drafts.conversation_memory}
        onClose={handleCloseDialog}
        onDraftChange={(next) => patchDraft("conversation_memory", next)}
        onSave={handleSaveDialog}
      />
      <SafetyGuardrailsConfigDialog
        open={activeDialog === "safety_guardrails"}
        draft={drafts.safety_guardrails}
        onClose={handleCloseDialog}
        onDraftChange={(next) => patchDraft("safety_guardrails", next)}
        onSave={handleSaveDialog}
      />
      <AutomaticRetriesConfigDialog
        open={activeDialog === "automatic_retries"}
        draft={drafts.automatic_retries}
        onClose={handleCloseDialog}
        onDraftChange={(next) => patchDraft("automatic_retries", next)}
        onSave={handleSaveDialog}
      />
      <AgentRateLimitingConfigDialog
        open={activeDialog === "api_rate_limiting"}
        draft={drafts.api_rate_limiting}
        onClose={handleCloseDialog}
        onDraftChange={(next) => patchDraft("api_rate_limiting", next)}
        onSave={handleSaveDialog}
      />
    </section>
  );
}

export { ConfigurationSection };
export type { ConfigurationSectionProps };
