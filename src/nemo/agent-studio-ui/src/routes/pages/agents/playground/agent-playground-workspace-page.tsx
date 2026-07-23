import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useNavigate, useParams } from "react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import { shouldSkipQuery } from "@/api/api.slice";
import { Button } from "@/ui-lib/base-components/button/button";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import {
  useGetAgentQuery,
  useListProjectModelsQuery,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import { useLazyGetAgentSessionQuery } from "@/routes/pages/agents/api/agents-runtime-api.slice";
import { isTeamAgentId } from "@/routes/pages/agents/utils/agents-api-mapper";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { projectContextSelector } from "@/store/selectors/project-context.selector";

import { AGENTS_STRINGS, agentPaths, NEW_CONVERSATION_SESSION_ID } from "../agents.consts";
import { PlaygroundChatPanel } from "./components/playground-chat-panel";
import { RunDetailsPanel } from "./components/run-details-panel";
import {
  cancelAgentStream,
  playgroundReset,
  selectIsStreaming,
  selectLastRunMetrics,
  selectLiveAgentActivity,
  selectLiveExecutionSteps,
  selectPlaygroundMessages,
  selectPlaygroundSessionId,
  sendAgentMessage,
  sessionLoaded,
} from "@/store";
import { agentToDisplayConfig, type PlaygroundModelLookup } from "./agent-playground.utils";
import type { AgentPlaygroundDisplayConfig } from "./agent-playground.utils";
import {
  isNewConversationSessionId,
  sessionMessagesToPlaygroundMessages,
} from "./agent-playground-session.utils";
import "./agent-playground-workspace-page.scss";

function AgentPlaygroundWorkspacePage(): ReactElement {
  const navigate = useNavigate();
  const { agentId } = useParams<{ agentId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const isTeam = !!agentId && isTeamAgentId(agentId);
  const isSingle = !!agentId && !isTeam;
  const skip = shouldSkipQuery() || !projectId || !agentId;

  // Saved agent + project models drive the Run details Configuration tab and the
  // chat header title. Teams use a different shape, so `displayConfig` stays null
  // for them and the panel relies on the live timeline/tracing.
  const { data: savedAgent, isLoading: isAgentLoading } = useGetAgentQuery(
    { projectId, id: agentId ?? "" },
    { skip: skip || !isSingle },
  );
  const { data: projectModels } = useListProjectModelsQuery(
    { projectId, modelType: "llm" },
    { skip: skip || !isSingle },
  );

  const modelLookup = useMemo<PlaygroundModelLookup[]>(() => {
    const rows: PlaygroundModelLookup[] = [...(projectModels ?? [])];
    if (savedAgent?.model) {
      rows.push(savedAgent.model);
    }
    if (savedAgent?.fallbackModels?.length) {
      rows.push(...savedAgent.fallbackModels);
    }
    return rows;
  }, [projectModels, savedAgent]);

  const displayConfig = useMemo<AgentPlaygroundDisplayConfig | null>(() => {
    if (isTeam || !savedAgent) {
      return null;
    }
    return agentToDisplayConfig(
      {
        id: savedAgent.id,
        name: savedAgent.name,
        role: savedAgent.role,
        systemPrompt: savedAgent.systemPrompt,
        modelId: savedAgent.modelId,
        modelClass: savedAgent.modelClass,
        temperature: savedAgent.temperature ?? undefined,
        maxTokens: savedAgent.maxTokens ?? undefined,
        ragConfig: savedAgent.ragConfig ?? undefined,
        memoryType: savedAgent.memoryType,
      },
      projectModels ?? [],
    );
  }, [isTeam, savedAgent, projectModels]);

  const agentName = savedAgent?.name ?? agentId ?? "";

  // Run details column is hidden until the user opts in via the chat header
  // "Show details" action, matching the in-form playground behaviour.
  const [showRunDetails, setShowRunDetails] = useState(false);
  const handleToggleRunDetails = useCallback(() => {
    setShowRunDetails((current) => !current);
  }, []);

  // Session selected in the RunDetailsPanel dropdown (user-controlled, but
  // auto-follows each completed run). Uses the "adjust state during render"
  // pattern to avoid an extra committed render from effect-triggered setState.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    NEW_CONVERSATION_SESSION_ID,
  );
  const [prevLastRunSessionId, setPrevLastRunSessionId] = useState<string | null>(null);

  // Playground streaming state lives in the agent-playground Redux slice; the
  // SSE consumption + abort lifecycle are owned by the `sendAgentMessage`
  // thunk. This page only selects state and dispatches.
  const dispatch = useAppDispatch();
  const messages = useAppSelector(selectPlaygroundMessages);
  const liveExecutionSteps = useAppSelector(selectLiveExecutionSteps);
  const liveAgentActivity = useAppSelector(selectLiveAgentActivity);
  const lastRunMetrics = useAppSelector(selectLastRunMetrics);
  const isStreaming = useAppSelector(selectIsStreaming);
  const reduxSessionId = useAppSelector(selectPlaygroundSessionId);

  const [fetchSession] = useLazyGetAgentSessionQuery();

  // Ref lets the async fetch callback guard against stale selections when the
  // user switches sessions quickly before a previous fetch resolves.
  const selectedSessionIdRef = useRef<string | null>(NEW_CONVERSATION_SESSION_ID);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const sendMessage = useCallback(
    (text: string, overrides?: { modelId?: string }) => {
      dispatch(
        sendAgentMessage(agentId ?? null, text, {
          ...overrides,
          interactionMode: displayConfig?.mode,
        }),
      );
    },
    [dispatch, agentId, displayConfig?.mode],
  );

  // Ensures a just-completed session appears in the dropdown immediately,
  // before the list query refetches from the server.
  const pendingSessionIds = useMemo(() => {
    const id = lastRunMetrics?.sessionId ?? reduxSessionId;
    return id ? [id] : [];
  }, [lastRunMetrics?.sessionId, reduxSessionId]);

  const handleSessionChange = useCallback(
    (newSessionId: string | null) => {
      setSelectedSessionId(newSessionId);
      selectedSessionIdRef.current = newSessionId;

      if (isNewConversationSessionId(newSessionId)) {
        dispatch(playgroundReset());
        return;
      }

      // Live session — messages are already in Redux from the just-completed run
      if (newSessionId === (lastRunMetrics?.sessionId ?? null)) return;
      if (!agentId || !newSessionId) return;

      void fetchSession({ id: agentId, sessionId: newSessionId, isTeam }).then((result) => {
        if (result.data && selectedSessionIdRef.current === newSessionId) {
          dispatch(
            sessionLoaded({
              messages: sessionMessagesToPlaygroundMessages(result.data.messages),
              sessionId: newSessionId,
            }),
          );
        }
      });
    },
    [agentId, isTeam, dispatch, fetchSession, lastRunMetrics?.sessionId],
  );

  // Start each agent's playground from a clean transcript, and abort any
  // in-flight stream when navigating away or switching agents.
  useEffect(() => {
    dispatch(playgroundReset());
    return () => {
      dispatch(cancelAgentStream());
    };
  }, [dispatch, agentId]);

  // When a run completes the stream reports the (possibly new) session id via
  // `lastRunMetrics`. Follow it in the RunDetailsPanel so the panel reflects the
  // conversation the user just had. The user can still switch sessions manually;
  // the next run re-syncs. Updating state during render avoids an extra committed
  // render that effect-triggered setState would cause.
  const lastRunSessionId = lastRunMetrics?.sessionId ?? null;
  if (lastRunSessionId && lastRunSessionId !== prevLastRunSessionId) {
    setPrevLastRunSessionId(lastRunSessionId);
    setSelectedSessionId(lastRunSessionId);
  }

  const renderShowDetailsAction = useCallback(
    () => (
      <Button
        key="toggle-run-details"
        type="button"
        variant="outline"
        size="small"
        label={
          showRunDetails
            ? AGENTS_STRINGS.HIDE_OUTPUT_DETAILS
            : AGENTS_STRINGS.SHOW_OUTPUT_DETAILS
        }
        onClick={handleToggleRunDetails}
        aria-pressed={showRunDetails}
      />
    ),
    [handleToggleRunDetails, showRunDetails],
  );

  if (!agentId) {
    return (
      <div className="agent-playground-workspace agent-playground-workspace__empty">
        <Typography Component="h1" fontSize="fs20" boldness="semibold">
          {AGENTS_STRINGS.CHAT_REQUIRES_AGENT}
        </Typography>
        <Button
          variant="flat"
          size="medium"
          label={AGENTS_STRINGS.PAGE_TITLE}
          onClick={() => navigate(agentPaths.root)}
        />
      </div>
    );
  }

  if (isAgentLoading) {
    return (
      <div className="agent-playground-workspace agent-playground-workspace__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  return (
    <div className="agent-playground-workspace">
      <header className="agent-playground-workspace__header">
        <Button
          variant="icon"
          size="large"
          icon={<IconArrowLeft size={18} />}
          aria-label={AGENTS_STRINGS.PAGE_TITLE}
          onClick={() => navigate(agentPaths.detail(agentId))}
        />
        <div className="agent-playground-workspace__heading">
          <Typography Component="h1" fontSize="fs20" boldness="semibold">
            {agentName}
          </Typography>
          <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
            {AGENTS_STRINGS.SECONDARY_ACTION_PLAYGROUND}
          </Typography>
        </div>
      </header>

      <div
        className={
          showRunDetails
            ? "agent-playground-workspace__panels agent-playground-workspace__panels--with-details"
            : "agent-playground-workspace__panels"
        }
      >
        <div className="agent-playground-workspace__panel-slot">
          <PlaygroundChatPanel
            messages={messages}
            isLoading={isStreaming}
            onSendMessage={sendMessage}
            headerActions={[renderShowDetailsAction()]}
            modelLookup={modelLookup}
            agentActivity={liveAgentActivity}
          />
        </div>

        {showRunDetails && (
          <div className="agent-playground-workspace__panel-slot">
            <RunDetailsPanel
              agentId={agentId}
              selectedSessionId={selectedSessionId}
              onSessionChange={handleSessionChange}
              pendingSessionIds={pendingSessionIds}
              isChatLoading={isStreaming}
              lastRunMetrics={lastRunMetrics}
              liveExecutionSteps={liveExecutionSteps}
              displayConfig={displayConfig}
              modelLookup={modelLookup}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export { AgentPlaygroundWorkspacePage };
