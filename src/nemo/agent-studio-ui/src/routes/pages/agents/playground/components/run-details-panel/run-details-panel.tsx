import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { IconListDetails } from "@tabler/icons-react";

import {
  useGetAgentSessionQuery,
  useGetTraceSpansQuery,
  useListAgentSessionsQuery,
} from "../../../api/agents-runtime-api.slice";
import { shouldSkipQuery } from "@/api/api.slice";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group";
import type { TabItem } from "@/ui-lib/base-components/tab/tab";
import type { PlaygroundExecutionStep, PlaygroundRunMetrics } from "../../agent-playground.types";
import { buildPlaygroundRunStatistics } from "../../agent-playground-statistics.utils";
import {
  buildPlaygroundRunMetricsFromSessionDetail,
  getAgentSessionSummaryId,
  mergeAgentSessionSummaries,
} from "../../agent-playground-session.utils";
import {
  buildTracingStepsFromAgentTrace,
  buildTracingStepsFromProvenance,
  buildTracingStepsFromSpans,
  findLatestAssistantTraceId,
} from "../../agent-playground-tracing.utils";
import {
  AGENTS_STRINGS,
  NEW_CONVERSATION_SESSION_ID,
} from "../../../agents.consts";
import { isTeamAgentId } from "../../../utils/agents-api-mapper";
import { isNewConversationSessionId } from "../../agent-playground-session.utils";
import type { AgentPlaygroundDisplayConfig, PlaygroundModelLookup } from "../../agent-playground.utils";
import { RunDetailsConfigurationTab } from "../run-details-configuration-tab";
import { RunDetailsExecutionTab } from "../run-details-execution-tab";
import { RunDetailsStatisticsTab } from "../run-details-statistics-tab";
import { RunDetailsTracingTab } from "../run-details-tracing-tab";
import "./run-details-panel.scss";

const RUN_DETAIL_TABS: TabItem[] = [
  { id: "execution", label: "Execution" },
  { id: "tracing", label: "Tracing" },
  { id: "statistics", label: "Statistics" },
  { id: "configuration", label: "Configuration" },
];

type RunDetailsPanelProps = {
  agentId: string | null;
  selectedSessionId: string | null;
  onSessionChange: (sessionId: string | null) => void;
  isChatLoading: boolean;
  lastRunMetrics: PlaygroundRunMetrics | null;
  liveExecutionSteps: PlaygroundExecutionStep[];
  displayConfig: AgentPlaygroundDisplayConfig | null;
  modelLookup?: PlaygroundModelLookup[];
  pendingSessionIds?: string[];
  /** Optional actions rendered in the panel header (e.g. the in-form expand/collapse toggle). */
  headerActions?: ReactNode[];
};

function RunDetailsPanel({
  agentId,
  selectedSessionId,
  onSessionChange,
  isChatLoading,
  lastRunMetrics,
  liveExecutionSteps,
  displayConfig,
  modelLookup = [],
  pendingSessionIds = [],
  headerActions,
}: RunDetailsPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState("execution");
  const skip = shouldSkipQuery() || !agentId;
  const isTeam = !!agentId && isTeamAgentId(agentId);

  const { data: sessionsData } = useListAgentSessionsQuery(
    { id: agentId ?? "", isTeam },
    { skip },
  );
  const isNewConversation = isNewConversationSessionId(selectedSessionId);

  const { data: sessionDetail } = useGetAgentSessionQuery(
    { id: agentId ?? "", sessionId: selectedSessionId ?? "", isTeam },
    { skip: skip || isNewConversation },
  );

  const runItems = useMemo(() => {
    const newConversationItem = {
      key: NEW_CONVERSATION_SESSION_ID,
      value: NEW_CONVERSATION_SESSION_ID,
      label: AGENTS_STRINGS.NEW_CONVERSATION,
    };

    const sessions = mergeAgentSessionSummaries(
      sessionsData?.sessions ?? [],
      pendingSessionIds,
    );
    const sessionItems = sessions.map((session) => {
      const sessionId = getAgentSessionSummaryId(session);
      return {
        key: sessionId,
        value: sessionId,
        label: session.name?.trim()
          ? session.name
          : `Session ${sessionId.slice(0, 8)}…`,
      };
    });

    if (isNewConversation) {
      return [newConversationItem, ...sessionItems];
    }

    const activeSessionId = selectedSessionId ?? "";
    const activeInList = sessionItems.some((item) => item.value === activeSessionId);
    if (activeInList) {
      return [newConversationItem, ...sessionItems];
    }

    const activeLabel = sessionDetail?.name?.trim()
      ? sessionDetail.name
      : `Session ${activeSessionId.slice(0, 8)}…`;

    return [
      newConversationItem,
      {
        key: activeSessionId,
        value: activeSessionId,
        label: activeLabel,
      },
      ...sessionItems,
    ];
  }, [isNewConversation, pendingSessionIds, selectedSessionId, sessionDetail, sessionsData]);

  const dropdownValue = isNewConversation
    ? NEW_CONVERSATION_SESSION_ID
    : (selectedSessionId ?? NEW_CONVERSATION_SESSION_ID);

  const sessionRunMetrics = useMemo(() => {
    if (isNewConversation) {
      return null;
    }
    return buildPlaygroundRunMetricsFromSessionDetail(sessionDetail, selectedSessionId);
  }, [isNewConversation, sessionDetail, selectedSessionId]);

  const displayRunMetrics = useMemo((): PlaygroundRunMetrics | null => {
    if (isNewConversation) {
      return null;
    }
    if (lastRunMetrics?.sessionId === selectedSessionId) {
      return lastRunMetrics;
    }
    return sessionRunMetrics;
  }, [isNewConversation, lastRunMetrics, selectedSessionId, sessionRunMetrics]);

  const traceId = useMemo(() => {
    if (displayRunMetrics?.traceId) {
      return displayRunMetrics.traceId;
    }
    return findLatestAssistantTraceId(sessionDetail?.messages);
  }, [displayRunMetrics, sessionDetail]);

  const { data: traceSpans = [] } = useGetTraceSpansQuery(traceId ?? "", {
    skip: skip || !traceId,
  });

  const tracingSteps = useMemo(() => {
    const fromSpans = buildTracingStepsFromSpans(traceSpans);
    if (fromSpans.length > 0) return fromSpans;
    // Fallback 1: persisted session — MAF without Phoenix wired emits an
    // agentTrace[] on the assistant message; render that as a trace timeline.
    const fromMessages = buildTracingStepsFromAgentTrace(sessionDetail?.messages);
    if (fromMessages.length > 0) return fromMessages;
    // Fallback 2: live path — a brand-new session has no persisted messages
    // yet, but the just-completed run's agentTrace is already in lastRunMetrics.
    return buildTracingStepsFromProvenance(displayRunMetrics?.provenance);
  }, [traceSpans, sessionDetail, displayRunMetrics]);

  const runStatistics = useMemo(
    () => buildPlaygroundRunStatistics(displayRunMetrics, traceSpans, displayConfig),
    [displayConfig, displayRunMetrics, traceSpans],
  );

  const executionSteps = liveExecutionSteps.length > 0
    ? liveExecutionSteps
    : (displayRunMetrics?.executionSteps ?? []);

  const isExecutionLoading = isChatLoading && executionSteps.length === 0;
  const isTracingLoading = isChatLoading && tracingSteps.length === 0;

  return (
    <Card className="agent-run-details">
      <CardHeader
        icon={<IconListDetails size={20} />}
        title={AGENTS_STRINGS.OUTPUT_DETAILS_TITLE}
        actions={headerActions}
        hasSeparator
      />

      <div className="agent-run-details__toolbar">
        <SelectDropdown
          label="Run"
          items={runItems}
          value={dropdownValue}
          onValueChange={(val) => {
            if (typeof val === "string") {
              onSessionChange(val);
            }
          }}
          placeholder={AGENTS_STRINGS.NEW_CONVERSATION}
          variant="field"
          size="medium"
          disabled={!agentId}
        />
      </div>

      <TabGroup
        tabs={RUN_DETAIL_TABS}
        activeTabId={activeTab}
        variant="general"
        onTabChange={setActiveTab}
        ariaLabel="Output details tabs"
        className="agent-run-details__tabs"
      >
        <TabContent tabId="execution" className="agent-run-details__tab-panel">
          <RunDetailsExecutionTab
            steps={executionSteps}
            isLoading={isExecutionLoading}
            emptyMessage={AGENTS_STRINGS.EXECUTION_EMPTY_NO_STEPS}
          />
        </TabContent>
        <TabContent tabId="tracing" className="agent-run-details__tab-panel">
          <RunDetailsTracingTab
            steps={tracingSteps}
            isLoading={isTracingLoading}
            emptyMessage={AGENTS_STRINGS.TRACING_EMPTY_NO_STEPS}
          />
        </TabContent>
        <TabContent tabId="statistics" className="agent-run-details__tab-panel">
          <RunDetailsStatisticsTab statistics={runStatistics} />
        </TabContent>
        <TabContent tabId="configuration" className="agent-run-details__tab-panel">
          <RunDetailsConfigurationTab
            lastRunMetrics={displayRunMetrics}
            displayConfig={displayConfig}
            modelLookup={modelLookup}
          />
        </TabContent>
      </TabGroup>
    </Card>
  );
}

export { RunDetailsPanel };
export type { RunDetailsPanelProps };
