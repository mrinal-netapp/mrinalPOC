import type { ReactElement } from "react";
import { IconBox } from "@tabler/icons-react";

import { Card } from "@/ui-lib/base-components/card/card";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import {
  AGENT_FEATURE_LIST,
  buildFeatureBody,
} from "../../../create-edit/form/agent-form.consts";
import type { AgentConfigurationSummary } from "../../agent-detail-page.types";
import { PanelDeferredState } from "../panel-deferred-state";
import { CONFIGURATIONS_PANEL_STRINGS } from "./configurations-panel.consts";
import "./configurations-panel.scss";

interface ConfigurationsPanelProps {
  /**
   * The agent's feature configuration. Undefined for team agents (which have
   * no single-agent feature cards) — the panel then shows the placeholder.
   */
  configuration?: AgentConfigurationSummary;
}

/**
 * Renders the Configurations tab on the Agent details page.
 *
 * Mirrors the create/edit Configuration section read-only: the same feature
 * list and `buildFeatureBody` rows are reused so the two surfaces never drift.
 * When no configuration is available (team agents) it delegates to the shared
 * `PanelDeferredState` placeholder.
 */
function ConfigurationsPanel({
  configuration,
}: ConfigurationsPanelProps): ReactElement {
  if (!configuration) {
    return (
      <PanelDeferredState
        resourceLabel={CONFIGURATIONS_PANEL_STRINGS.RESOURCE_LABEL}
      />
    );
  }

  const { enabledFeatures, featureConfig } = configuration;

  return (
    <div className="configurations-panel">
      {AGENT_FEATURE_LIST.map((meta) => {
        const enabled = enabledFeatures.includes(meta.key);
        const rows = buildFeatureBody(meta.key, enabled, featureConfig);
        return (
          <Card key={meta.key}>
            <div className="configurations-panel__card-header">
              <div className="configurations-panel__card-title-row">
                <span
                  className="configurations-panel__card-icon"
                  aria-hidden="true"
                >
                  <IconBox size={16} />
                </span>
                <Typography fontSize="fs14" boldness="semibold">
                  {meta.title}
                </Typography>
              </div>
              <span
                className={
                  enabled
                    ? "configurations-panel__status configurations-panel__status--on"
                    : "configurations-panel__status configurations-panel__status--off"
                }
              >
                {enabled ? "Enabled" : "Disabled"}
              </span>
            </div>

            <div className="configurations-panel__card-body">
              {rows.map((row) => (
                <div key={row.label} style={{ display: "contents" }}>
                  <Typography
                    fontSize="fs14"
                    className="configurations-panel__row-label"
                  >
                    {row.label}
                  </Typography>
                  <Typography fontSize="fs14">{row.value}</Typography>
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export { ConfigurationsPanel };
export type { ConfigurationsPanelProps };
