import type { ReactElement, ReactNode } from "react";
import { Link } from "react-router";
import { IconArrowUpRight } from "@tabler/icons-react";

import { CardBlockLabel, CardBlockValue } from "@/ui-lib/base-components/card/card.block";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { kbPaths } from "@/routes/pages/knowledge-base/knowledge-base.consts";
import type { PlaygroundRunMetrics } from "../../agent-playground.types";
import type { AgentPlaygroundDisplayConfig, PlaygroundModelLookup } from "../../agent-playground.utils";
import { formatPlaygroundToolStatus, resolvePlaygroundModelName } from "../../agent-playground.utils";
import "./run-details-configuration-tab.scss";

type RunDetailsConfigurationTabProps = {
  lastRunMetrics: PlaygroundRunMetrics | null;
  displayConfig: AgentPlaygroundDisplayConfig | null;
  modelLookup?: PlaygroundModelLookup[];
};

function ConfigSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="run-details-configuration__section">
      <Typography
        Component="h3"
        fontSize="fs14"
        boldness="semibold"
        className="run-details-configuration__section-title"
      >
        {title}
      </Typography>
      {children}
    </section>
  );
}

function ConfigRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="run-details-configuration__row">
      <CardBlockLabel>{label}</CardBlockLabel>
      <CardBlockValue>{children}</CardBlockValue>
    </div>
  );
}

function ConfigLink({
  label,
  href,
}: {
  label: string;
  href?: string;
}): ReactElement {
  if (!href) {
    return (
      <span className="run-details-configuration__link">
        <Typography Component="span" fontSize="fs14" color="var(--text-button-primary)">
          {label}
        </Typography>
        <IconArrowUpRight size={14} aria-hidden />
      </span>
    );
  }

  return (
    <Link to={href} className="run-details-configuration__link">
      <Typography Component="span" fontSize="fs14" color="var(--text-button-primary)">
        {label}
      </Typography>
      <IconArrowUpRight size={14} aria-hidden />
    </Link>
  );
}

function RunDetailsConfigurationTab({
  lastRunMetrics,
  displayConfig,
  modelLookup = [],
}: RunDetailsConfigurationTabProps): ReactElement {
  if (!lastRunMetrics) {
    return (
      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
        Send a message in Chat to see configuration for the latest run.
      </Typography>
    );
  }

  const kbStats = lastRunMetrics.kbStats ?? [];
  // Filter out KB tools from the Toolsets section. MAF's wire payload now
  // tags each tool execution with toolType ("kb" | "toolset"); before this
  // discriminator existed every tool — including kb_retrieve — landed in
  // toolStats and leaked into the Toolsets section alongside MCP tools.
  // The KB section already renders these via kbStats; double-counting them
  // here was confusing. Entries without a toolType (legacy / unknown) keep
  // their existing fall-through behaviour and stay in the Toolsets list.
  const toolStats = (lastRunMetrics.toolStats ?? []).filter(
    (stat) => stat.toolType !== "kb",
  );
  const runModelConfig = lastRunMetrics.modelConfig;
  // The run's own provenance carries the responding agent's model + temperature,
  // so the Configuration tab can render from the completed run alone. displayConfig
  // (sourced from the saved agent) is an optional enhancement — it fills params the
  // run doesn't surface (top-p/top-k/token-limit) and a friendlier model name — but
  // its absence (e.g. teams, or before the agent query resolves) must NOT blank the
  // whole tab.
  const respondingAgent = lastRunMetrics.provenance?.respondingAgent;

  const rawModelName =
    lastRunMetrics?.modelName ?? respondingAgent?.model ?? undefined;
  const modelName =
    resolvePlaygroundModelName(rawModelName, modelLookup)
    ?? displayConfig?.modelDisplayName
    ?? rawModelName
    ?? "—";
  const temperature =
    runModelConfig?.temperature ?? respondingAgent?.temperature ?? displayConfig?.temperature;
  const topP = runModelConfig?.topP ?? displayConfig?.topP;
  const topK = runModelConfig?.topK ?? displayConfig?.topKChunks;
  const tokenLimit = runModelConfig?.maxTokens ?? displayConfig?.tokenLimit;

  return (
    <div className="run-details-configuration">
      <ConfigSection title="Knowledge bases">
        {kbStats.length === 0 ? (
          <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
            No knowledge bases were used in this run.
          </Typography>
        ) : (
          kbStats.map((stat) => (
            <div key={stat.knowledgeBaseId} className="run-details-configuration__group">
              <ConfigRow label="Knowledge base">
                <ConfigLink
                  label={stat.knowledgeBaseName}
                  href={kbPaths.detail(stat.knowledgeBaseId)}
                />
              </ConfigRow>
              <ConfigRow label="Retrieved chunks">
                {stat.retrievedChunks}
              </ConfigRow>
              <ConfigRow label="Total tokens used">
                {stat.tokensUsed}
              </ConfigRow>
            </div>
          ))
        )}
      </ConfigSection>

      <ConfigSection title="Toolsets">
        {toolStats.length === 0 ? (
          <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
            No toolsets were used in this run.
          </Typography>
        ) : (
          toolStats.map((stat) => (
            <div
              key={`${stat.serverId}-${stat.toolName}`}
              className="run-details-configuration__group"
            >
              <ConfigRow label="Toolset">
                <ConfigLink label={stat.serverName || "—"} />
              </ConfigRow>
              <ConfigRow label="Used tool">
                {stat.toolName}
              </ConfigRow>
              <ConfigRow label="Status">
                {formatPlaygroundToolStatus(stat.status)}
              </ConfigRow>
              <ConfigRow label="Latency">
                {stat.latencyMs} ms
              </ConfigRow>
            </div>
          ))
        )}
      </ConfigSection>

      <ConfigSection title="Model">
        <div className="run-details-configuration__group">
          <ConfigRow label="Model name">
            <ConfigLink label={modelName} />
          </ConfigRow>
          <ConfigRow label="Temperature">
            {temperature ?? "—"}
          </ConfigRow>
          <ConfigRow label="Top-p">
            {topP ?? "—"}
          </ConfigRow>
          <ConfigRow label="Top-k">
            {topK == null ? "—" : `${topK} chunks`}
          </ConfigRow>
          <ConfigRow label="Token limit">
            {tokenLimit ?? "—"}
          </ConfigRow>
        </div>
      </ConfigSection>
    </div>
  );
}

export { RunDetailsConfigurationTab };
export type { RunDetailsConfigurationTabProps };
