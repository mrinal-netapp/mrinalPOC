import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate, useBlocker } from "react-router";
import { useForm } from "@tanstack/react-form";
import { useStore } from "@tanstack/react-store";
import {
  IconX,
  IconRefresh,
  IconEye,
  IconChevronDown,
  IconPlus,
  IconBox,
  IconArrowsMaximize,
  IconArrowsMinimize,
} from "@tabler/icons-react";

import { Form } from "@/ui-lib/base-components/form";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Button } from "@/ui-lib/base-components/button/button";
import { buttonVariants } from "@/ui-lib/base-components/button/button.variants";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { Dialog, DialogPopup, DialogTitle } from "@/ui-lib/base-components/dialog/dialog";
import { toast } from "@/ui-lib/base-components/toast/toast";

import { shouldSkipQuery } from "@/api/api.slice";
import { agentPaths, AGENT_STRINGS, DEPLOY_LOCKED_CLASS, LOCK_AGENT_DEPLOY, isDeployActivationLocked, NEW_CONVERSATION_SESSION_ID } from "@/routes/pages/agents/agents.consts";
import {
  useCreateAgentMutation,
  useCreateAgentTeamMutation,
  useDeleteAgentMutation,
  useGetAgentQuery,
  useGetAgentTeamQuery,
  useListProjectModelsQuery,
  useUpdateAgentMutation,
  useUpdateAgentStatusMutation,
  useUpdateAgentTeamMutation,
  useUpdateAgentTeamStatusMutation,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import { useLazyGetAgentSessionQuery } from "@/routes/pages/agents/api/agents-runtime-api.slice";
import {
  isTeamAgentId,
  mapFormToCreateRequest,
  mapFormToCreateTeamRequest,
  mapTemplateAgentInstanceToCreateRequest,
  mapTemplateToCreateTeamRequest,
} from "@/routes/pages/agents/utils/agents-api-mapper";
import {
  rollbackCreatedTemplateMembers,
  type TemplateMemberRollbackResult,
} from "@/routes/pages/agents/utils/template-member-rollback";
import { formatAgentSaveErrorMessage } from "@/routes/pages/agents/utils/agent-save-error.utils";

import { PlaygroundChatPanel } from "@/routes/pages/agents/playground/components/playground-chat-panel";
import { RunDetailsPanel } from "@/routes/pages/agents/playground/components/run-details-panel";
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
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  isAgentPlaygroundReady,
} from "@/routes/pages/agents/playground/agent-playground-readiness.utils";
import { agentToDisplayConfig, type PlaygroundModelLookup } from "@/routes/pages/agents/playground/agent-playground.utils";
import type { AgentPlaygroundDisplayConfig } from "@/routes/pages/agents/playground/agent-playground.utils";
import { getStructuredOutputSaveError } from "@/routes/pages/agents/utils/json-schema-validation";
import {
  isNewConversationSessionId,
  sessionMessagesToPlaygroundMessages,
} from "@/routes/pages/agents/playground/agent-playground-session.utils";

import {
  DEFAULT_SAVE_AGENT_VALUES,
  SAVE_AGENT_DIALOG_STRINGS,
  SaveAgentDialog,
  type SaveAgentMode,
  type SaveAgentValues,
} from "../configure-dialogs/save-agent-dialog";

import { agentNamePatternError, buildAgentDefaultValues } from "./agent-form.consts";
import type {
  AgentConfiguration,
  AgentFormValues,
  AgentResourceRequirement,
  AgentTemplateAgentInstanceValues,
} from "./agent-form.consts";
import {
  formatTemplateExamples,
  formatTemplateInstructions,
} from "./agent-templates.consts";
import type {
  AgentTemplateAgentDefinition,
  AgentTemplateDefinition,
} from "./agent-templates.consts";

type TemplateDetailsKind = "examples" | "instructions";
import { SetupSection } from "./setup-section";
import { ModelSection } from "./model-section";
import { ProfileSection } from "./profile-section";
import { KnowledgeBasesSection } from "./knowledge-bases-section";
import { ToolsetSection } from "./toolset-section";
import { ConfigurationSection } from "./configuration-section";
import { TeamConfigSection } from "./team-config-section";
import { TeamAgentsSection } from "./team-agents-section";
import { TeamTeamsSection } from "./team-teams-section";
import { TemplateSection } from "./template-section";
import { TemplateAgentsSection } from "./template-agents-section";
import {
  collectTemplateAgentSaveErrors,
  collectTemplateManagerSaveErrors,
  collectSkippedOptionalDependencies,
  isTemplateManagerConfigured,
  areTemplateRequiredDependenciesAttached,
  orchestrationRequiresInlineManager,
  type SkippedDependency,
} from "./template-agent.utils";
import { DeployConfirmationDialog } from "../configure-dialogs/deploy-confirmation-dialog";

import "../../../data-management/dataset/create-edit/form/dataset-form.scss";
import "./agent-form.scss";

interface AgentFormProps {
  isEdit?: boolean;
  /** Present only in edit mode — the id of the agent being updated. */
  agentId?: string;
  /**
   * Where to navigate after a successful save. Defaults to the agents
   * list root. Pass `agentPaths.detail(id)` when the user arrived via
   * the detail page's Edit button so they land back on that detail view.
   */
  returnTo?: string;
  initialData?: Partial<AgentFormValues>;
  /**
   * Identity (name / description / labels) of the entity being edited. Seeds
   * the SaveAgentDialog so editing an existing agent pre-fills its name rather
   * than opening blank. Undefined in create mode.
   */
  initialIdentity?: SaveAgentValues;
}

type FormValidationErrors = {
  primaryModel?: string;
  goal?: string;
  instructions?: string;
  structuredOutput?: string;
  knowledgeBases?: string;
  toolsets?: string;
};

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

type ActiveTemplateDetails = {
  kind: TemplateDetailsKind;
  content: string;
};

function AgentForm({ isEdit = false, agentId, returnTo, initialData, initialIdentity }: AgentFormProps): ReactElement {
  const navigate = useNavigate();

  const [createAgent] = useCreateAgentMutation();
  const [updateAgent] = useUpdateAgentMutation();
  const [updateAgentStatus] = useUpdateAgentStatusMutation();
  const [createAgentTeam] = useCreateAgentTeamMutation();
  const [updateAgentTeam] = useUpdateAgentTeamMutation();
  const [updateAgentTeamStatus] = useUpdateAgentTeamStatusMutation();
  const [deleteAgent] = useDeleteAgentMutation();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const pageTitle = isEdit ? "Edit agent" : AGENT_STRINGS.PAGE_TITLE;

  const defaultValues = useMemo<AgentFormValues>(
    () => ({ ...buildAgentDefaultValues(), ...initialData }),
    [initialData],
  );

  const form = useForm({
    defaultValues,
    // The form-level submit is intentionally a no-op: the agent save flow
    // is owned by the SaveAgentDialog → `handleConfirmSave` path below,
    // which captures identity (name, description, labels) before the
    // payload is dispatched. Keeping this empty (rather than removing it)
    // satisfies TanStack's required option without growing dead code.
    onSubmit: async () => {},
  }) as unknown as AnyReactFormApi;

  const isDirty = useStore(form.store, (s) => s.isDirty);
  const configuration: AgentConfiguration = useStore(
    form.store,
    (s: { values: { configuration: AgentConfiguration } }) => s.values.configuration,
  );
  const [validationErrors, setValidationErrors] = useState<FormValidationErrors>({});
  const [templateValidationByAgent, setTemplateValidationByAgent] = useState<
    Record<number, FormValidationErrors>
  >({});
  const [managerValidation, setManagerValidation] = useState<FormValidationErrors>({});
  const templateAgentInstances = useStore(
    form.store,
    (s) => s.values.template.agentInstances as AgentTemplateAgentInstanceValues[],
  );
  const templateManagerInstance = useStore(
    form.store,
    (s) => s.values.template.managerInstance as AgentTemplateAgentInstanceValues,
  );
  const selectedTemplate = useStore(
    form.store,
    (s) => s.values.template.selectedTemplate,
  );
  const templateOrchestrationPattern = useStore(
    form.store,
    (s) => s.values.template.orchestrationPattern as string,
  );

  // Deploy is enabled once every member agent has its basics (model, goal,
  // instructions) and the manager is configured. Required KB/toolset
  // requirements are validated when the user actually attempts the deploy (so
  // the per-requirement "must be configured or removed" errors can surface),
  // and unconfigured optional dependencies are acknowledged in the deploy
  // confirmation dialog.
  const canDeploy = useMemo(() => {
    if (configuration !== "from_template") return true;
    if (!selectedTemplate) return false;
    const agentsBasicReady = selectedTemplate.agents.every(
      (_agentDef: AgentTemplateAgentDefinition, index: number) => {
        const instance = templateAgentInstances[index];
        return Boolean(
          hasText(instance?.primaryModel) &&
            hasText(instance?.name) &&
            hasText(instance?.instructions),
        );
      },
    );
    // Grey out deploy early when a required KB/MCP is still unconfigured —
    // mirrors the single-agent flow instead of only erroring on click.
    const requiredDepsAttached = areTemplateRequiredDependenciesAttached(
      selectedTemplate,
      templateAgentInstances,
    );
    const managerReady =
      !orchestrationRequiresInlineManager(templateOrchestrationPattern) ||
      isTemplateManagerConfigured(templateManagerInstance);
    return agentsBasicReady && managerReady && requiredDepsAttached;
  }, [
    configuration,
    selectedTemplate,
    templateAgentInstances,
    templateManagerInstance,
    templateOrchestrationPattern,
  ]);
  const canSaveDraft = useMemo(() => {
    if (configuration !== "from_template") return true;
    return Boolean(selectedTemplate);
  }, [configuration, selectedTemplate]);
  const [activeTemplateDetails, setActiveTemplateDetails] = useState<ActiveTemplateDetails | null>(
    null,
  );
  // The details drawer portals into <body> so it can sit flush against the
  // right edge of the viewport (mirrors the Project Switcher drawer).
  const renderedTemplateDetails =
    configuration === "from_template" ? activeTemplateDetails : null;
  const templateDetailsContainer = typeof document === "undefined" ? undefined : document.body;

  // Playground readiness is derived from the live form values so the chat panel
  // enables/disables as the user completes the required configuration. The
  // runtime still runs the SAVED agent, so `isEdit` is also required.
  const primaryModel = useStore(form.store, (s) => s.values.primaryModel);
  const fallbackModel = useStore(form.store, (s) => s.values.fallbackModel);
  const team = useStore(form.store, (s) => s.values.team);
  const requirements = useStore(form.store, (s) => s.values.requirements);
  const unresolvedDependencies = useMemo(
    () => [
      ...(requirements?.knowledgeBases ?? []).map((requirement: AgentResourceRequirement) => ({
        type: "Knowledge base" as const,
        label: requirement.label || requirement.id,
        required: requirement.required,
      })),
      ...(requirements?.mcpServers ?? []).map((requirement: AgentResourceRequirement) => ({
        type: "Toolset" as const,
        label: requirement.label || requirement.id,
        required: requirement.required,
      })),
    ],
    [requirements],
  );
  const hasBlockingUnresolvedDependencies = unresolvedDependencies.some(
    (dependency) => dependency.required,
  );
  const playgroundReadiness = useMemo(
    () =>
      isAgentPlaygroundReady(
        { configuration, primaryModel, fallbackModel, team, requirements },
        isEdit,
      ),
    [configuration, primaryModel, fallbackModel, team, requirements, isEdit],
  );

  const isTeam = isEdit && !!agentId && isTeamAgentId(agentId);

  // Run-details Configuration tab data for single agents. Sourced from the
  // SAVED agent (what the runtime actually runs) + the project model list to
  // resolve the model's display name. Teams use a different shape, so we leave
  // `displayConfig` null for them and rely on the live timeline/tracing.
  const { data: savedAgent } = useGetAgentQuery(
    { projectId, id: agentId ?? "" },
    { skip: shouldSkipQuery() || !projectId || !isEdit || !agentId || isTeam },
  );
  const { data: savedTeam } = useGetAgentTeamQuery(
    { projectId, id: agentId ?? "" },
    { skip: shouldSkipQuery() || !projectId || !isEdit || !agentId || !isTeam },
  );
  const { data: projectModels } = useListProjectModelsQuery(
    { projectId, modelType: "llm" },
    { skip: shouldSkipQuery() || !projectId || !isEdit || isTeam },
  );
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

  // After a successful save the form is still "dirty" (we don't reset it before
  // navigating away), so the leave-guard below would otherwise intercept the
  // post-save redirect with the "Discard changes?" dialog. This ref lets a
  // confirmed save bypass the guard for that one navigation.
  const skipLeaveGuardRef = useRef(false);
  const blocker = useBlocker(
    useCallback(() => isDirty && !skipLeaveGuardRef.current, [isDirty]),
  );
  const isBlocked = blocker.state === "blocked";

  // Default workbench layout is a 50/50 grid showing only the Agent
  // configuration and Chat panels — the Run details column is hidden until
  // the user opts in via the "Show details" button on the Chat header
  // (`showRunDetails`). When toggled on, the workbench expands to the
  // 33/33/33 three-column layout. Each card additionally exposes a
  // maximize action that "focuses" that panel — the others are hidden
  // until the user clicks the (now minimize) icon again. `focusedPanel ===
  // null` is the default unfocused layout.
  type FocusedPanel = "config" | "chat" | "run";
  const [focusedPanel, setFocusedPanel] = useState<FocusedPanel | null>(null);
  const [showRunDetails, setShowRunDetails] = useState<boolean>(false);

  const handleTogglePanel = useCallback((panel: FocusedPanel) => {
    setFocusedPanel((current) => (current === panel ? null : panel));
  }, []);

  const handleToggleRunDetails = useCallback(() => {
    setShowRunDetails((current) => !current);
    // Toggling visibility from the Chat header is a "go back to the
    // overview" gesture — drop any focused panel so the user sees the new
    // 2- or 3-column layout immediately.
    setFocusedPanel(null);
  }, []);

  // Centralised visibility helper. A panel is hidden when either another
  // panel is focused (single-column mode) or when it's the Run details
  // panel and the user hasn't asked to see it yet.
  const isPanelHidden = useCallback(
    (panel: FocusedPanel): boolean => {
      if (focusedPanel) return focusedPanel !== panel;
      return panel === "run" && !showRunDetails;
    },
    [focusedPanel, showRunDetails],
  );

  const renderPanelExpandAction = useCallback(
    (panel: FocusedPanel, ariaLabel: string) => {
      const isFocused = focusedPanel === panel;
      return (
        <Button
          key={`expand-${panel}`}
          type="button"
          variant="icon"
          size="small"
          icon={isFocused ? <IconArrowsMinimize size={16} /> : <IconArrowsMaximize size={16} />}
          onClick={() => handleTogglePanel(panel)}
          aria-label={isFocused ? `Restore ${ariaLabel}` : `Maximize ${ariaLabel}`}
          aria-pressed={isFocused}
        />
      );
    },
    [focusedPanel, handleTogglePanel],
  );

  const renderShowDetailsAction = useCallback(() => {
    return (
      <Button
        key="toggle-run-details"
        type="button"
        variant="outline"
        size="small"
        label={showRunDetails ? "Hide details" : "Show details"}
        onClick={handleToggleRunDetails}
        aria-pressed={showRunDetails}
      />
    );
  }, [handleToggleRunDetails, showRunDetails]);

  // Active save dialog (null = closed). The submission flow is:
  //   Save dropdown → pick draft/deploy → SaveAgentDialog → submit
  // The cached identity values pre-fill the dialog if the user opens it again
  // after a Cancel, so they don't lose what they typed.
  const [saveMode, setSaveMode] = useState<SaveAgentMode | null>(null);
  const [savedIdentity, setSavedIdentity] = useState<SaveAgentValues>(
    initialIdentity ?? DEFAULT_SAVE_AGENT_VALUES,
  );

  // Template "Save and deploy" confirmation: after identity is captured we
  // surface the optional dependencies that will be skipped and require an
  // acknowledgment before committing the deploy.
  const [deployConfirmOpen, setDeployConfirmOpen] = useState(false);
  const [pendingDeployValues, setPendingDeployValues] = useState<SaveAgentValues | null>(null);
  const [skippedDeps, setSkippedDeps] = useState<SkippedDependency[]>([]);

  // Session selected in the RunDetailsPanel dropdown (user-controlled, but
  // auto-follows each completed run). We use the "adjust state during render"
  // pattern instead of useEffect so React batches the state update with the
  // render that observed the change, avoiding an extra committed render.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    NEW_CONVERSATION_SESSION_ID,
  );
  const [prevLastRunSessionId, setPrevLastRunSessionId] = useState<string | null>(null);

  // Live playground state — enabled only in edit mode where the agent already
  // exists server-side. In create mode there is no agent to stream, so
  // `playgroundAgentId` is null and `sendMessage` is a no-op.
  const playgroundAgentId = isEdit ? (agentId ?? null) : null;
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
        sendAgentMessage(playgroundAgentId, text, {
          ...overrides,
          interactionMode: displayConfig?.mode,
        }),
      );
    },
    [dispatch, playgroundAgentId, displayConfig?.mode],
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
      if (!playgroundAgentId || !newSessionId) return;

      void fetchSession({ id: playgroundAgentId, sessionId: newSessionId, isTeam }).then(
        (result) => {
          if (result.data && selectedSessionIdRef.current === newSessionId) {
            dispatch(
              sessionLoaded({
                messages: sessionMessagesToPlaygroundMessages(result.data.messages),
                sessionId: newSessionId,
              }),
            );
          }
        },
      );
    },
    [playgroundAgentId, isTeam, dispatch, fetchSession, lastRunMetrics?.sessionId],
  );

  // Start each agent's playground from a clean transcript, and abort any
  // in-flight stream when the form unmounts or the target agent changes.
  useEffect(() => {
    dispatch(playgroundReset());
    return () => {
      dispatch(cancelAgentStream());
    };
  }, [dispatch, playgroundAgentId]);

  // When a run completes the stream reports the (possibly new) session id via
  // `lastRunMetrics`. Follow it in the RunDetailsPanel so the panel reflects the
  // conversation the user just had. The user can still switch sessions manually;
  // the next run re-syncs. Updating state during render (not in an effect) lets
  // React skip the intermediate committed render caused by effect-triggered setState.
  const lastRunSessionId = lastRunMetrics?.sessionId ?? null;
  if (lastRunSessionId && lastRunSessionId !== prevLastRunSessionId) {
    setPrevLastRunSessionId(lastRunSessionId);
    setSelectedSessionId(lastRunSessionId);
  }

  const handleOpenSaveDialog = useCallback((mode: SaveAgentMode) => {
    setSaveMode(mode);
  }, []);

  const handleCloseSaveDialog = useCallback(() => {
    setSaveMode(null);
  }, []);

  // Performs the actual create/update + (optional) deploy. Split out from
  // validation so the template deploy flow can interleave the skipped-deps
  // confirmation dialog before committing.
  const performSave = useCallback(
    async (values: SaveAgentValues, mode: SaveAgentMode): Promise<void> => {
      const formValues = form.state.values as AgentFormValues;
      const effectiveFormValues: AgentFormValues =
        mode === "deploy"
          ? {
              ...formValues,
              requirements: {
                knowledgeBases: [],
                mcpServers: [],
              },
            }
          : formValues;
      const isTemplate = formValues.configuration === "from_template";
      const isTeam = formValues.configuration === "team" || isTemplate;

      // Profile field validation for single agents: goal and instructions are
      // required before saving so the agent has a defined purpose and behaviour.
      if (!isTeam) {
        const missingFields: string[] = [];
        if (!formValues.goal.trim()) missingFields.push("Goal");
        if (!formValues.instructions.trim()) missingFields.push("Instructions");
        if (missingFields.length > 0) {
          const fieldList = missingFields.join(" and ");
          const verb = missingFields.length === 1 ? "is" : "are";
          toast.error(
            `${fieldList} ${verb} required. Open the Profile section to configure.`,
          );
          return;
        }
      }
      // ``coordinate`` (→ MAF magentic) and ``route`` (→ MAF triage) both
      // need a manager — name, model, and instructions drive Magentic's
      // planning or triage's routing prompt respectively. Guard both paths.
      const requiresManager =
        isTeam
        && (formValues.team.orchestrationPattern === "coordinate"
          || formValues.team.orchestrationPattern === "route");
      if (requiresManager) {
        const missingFields: string[] = [];
        if (!hasText(formValues.team.managerName)) missingFields.push("manager name");
        if (!hasText(formValues.team.managerModel)) missingFields.push("manager model");
        if (!hasText(formValues.team.managerInstructions)) {
          missingFields.push("manager instructions");
        }
        if (missingFields.length > 0) {
          const policyLabel =
            formValues.team.orchestrationPattern === "route" ? "route" : "coordinate";
          toast.error(
            `Configure ${missingFields.join(", ")} before saving a ${policyLabel} team.`,
          );
          return;
        }
        // Reject an invalid manager name up front — a name with spaces/symbols
        // (e.g. "Triage Agent") crashes orchestration at build time. The inline
        // field validator surfaces this while typing; this guards submit.
        const managerNameError = agentNamePatternError(formValues.team.managerName);
        if (managerNameError) {
          toast.error(`Manager name: ${managerNameError}`);
          return;
        }
      }

      const saveContext: {
        memberRollback: TemplateMemberRollbackResult | null;
      } = { memberRollback: null };

      let saveSucceeded = false;

      try {
        let savedId: string;

        if (isTemplate) {
          // 1) Create each configured template agent as a single agent and
          //    collect their ids. 2) Create the team with those ids as members
          //    plus the inline manager built from the manager card.
          const template = formValues.template.selectedTemplate;
          const instances = formValues.template.agentInstances ?? [];
          const memberAgentIds: string[] = [];

          try {
            for (let index = 0; index < instances.length; index += 1) {
              const agentDef = template?.agents[index];
              if (!agentDef) continue;
              const created = await createAgent({
                projectId,
                body: mapTemplateAgentInstanceToCreateRequest(
                  instances[index],
                  agentDef,
                  values,
                ),
              }).unwrap();
              memberAgentIds.push(created.id);
            }

            const teamBody = mapTemplateToCreateTeamRequest(formValues, values, memberAgentIds);

            if (teamBody.members.length === 0) {
              toast.error("Add at least one agent before saving.");
              setSaveMode(null);
              return;
            }

            const result = await createAgentTeam({ projectId, body: teamBody }).unwrap();
            savedId = result.id;
            saveSucceeded = true;

            if (mode === "deploy") {
              await updateAgentTeamStatus({
                projectId,
                id: savedId,
                body: { deploymentStatus: "deployed" },
              }).unwrap();
            }
          } catch (templateErr) {
            if (!saveSucceeded && memberAgentIds.length > 0) {
              saveContext.memberRollback = await rollbackCreatedTemplateMembers(
                projectId,
                memberAgentIds,
                deleteAgent,
              );
            }
            throw templateErr;
          }
        } else if (isTeam) {
          const teamBody = mapFormToCreateTeamRequest(
            effectiveFormValues,
            values,
            isEdit && savedTeam?.manager
              ? { existingManager: savedTeam.manager }
              : undefined,
          );

          // The team endpoint requires at least one member; guard here so the
          // user gets actionable copy instead of a raw 400 from the server.
          if (teamBody.members.length === 0) {
            toast.error("Add at least one agent or team before saving.");
            setSaveMode(null);
            return;
          }

          if (isEdit && agentId) {
            const result = await updateAgentTeam({
              projectId,
              id: agentId,
              body: teamBody,
            }).unwrap();
            savedId = result.id;
          } else {
            const result = await createAgentTeam({
              projectId,
              body: teamBody,
            }).unwrap();
            savedId = result.id;
          }
          saveSucceeded = true;

          if (mode === "deploy") {
            await updateAgentTeamStatus({
              projectId,
              id: savedId,
              body: { deploymentStatus: "deployed" },
            }).unwrap();
          }
        } else {
          const requestBody = mapFormToCreateRequest(effectiveFormValues, values);
          if (mode === "deploy") {
            // Empty requirement arrays must be sent explicitly on deploy. Omitting
            // the field leaves existing DB placeholders in place, and the status
            // transition endpoint blocks on those stored requirements.
            requestBody.requirements = {
              knowledgeBases: [],
              mcpServers: [],
            };
          }

          if (isEdit && agentId) {
            const result = await updateAgent({
              projectId,
              id: agentId,
              body: requestBody,
            }).unwrap();
            savedId = result.id;
          } else {
            const result = await createAgent({
              projectId,
              body: requestBody,
            }).unwrap();
            savedId = result.id;
          }
          saveSucceeded = true;

          if (mode === "deploy") {
            await updateAgentStatus({
              projectId,
              id: savedId,
              body: { deploymentStatus: "deployed" },
            }).unwrap();
          }
        }

        setSaveMode(null);
        skipLeaveGuardRef.current = true;

        if (mode === "deploy") {
          toast.success(`${values.name} deployed successfully.`);
          navigate(returnTo ?? agentPaths.root);
        } else {
          toast.success(`${values.name} saved as draft.`);
          if (isTemplate) {
            // Templates create a team (+ its member agents) in one shot — there
            // is no in-place edit continuation, so return to the agents landing
            // screen like deploy does.
            navigate(returnTo ?? agentPaths.root);
          } else if (!isEdit) {
            // Single / team draft: redirect to the edit URL so `isEdit` becomes
            // true and the playground is enabled. Already-edit stays put.
            navigate(agentPaths.edit(savedId), { replace: true });
          }
        }
      } catch (err) {
        // Log the underlying failure (request-body mapping throw vs API error)
        // so save failures aren't silently swallowed.
        console.error(`Failed to save agent "${values.name}":`, err);
        const { memberRollback } = saveContext;
        if (memberRollback && memberRollback.attempted > 0) {
          if (memberRollback.failed.length === 0) {
            toast.error(
              `Failed to save ${values.name}. Created member agents were removed.`,
            );
          } else {
            toast.error(`Failed to save ${values.name}. Please try again.`);
            toast.warning(
              `Could not remove ${memberRollback.failed.length} created agent(s). Check the agents list.`,
            );
          }
        } else {
          toast.error(
            formatAgentSaveErrorMessage(err, {
              agentName: values.name,
              saveSucceeded,
            }),
          );
        }
      }
    },
    [
      form,
      navigate,
      isEdit,
      agentId,
      projectId,
      createAgent,
      updateAgent,
      updateAgentStatus,
      createAgentTeam,
      updateAgentTeam,
      updateAgentTeamStatus,
      deleteAgent,
      returnTo,
      savedTeam,
    ],
  );

  const handleConfirmSave = useCallback(
    async (values: SaveAgentValues, mode: SaveAgentMode): Promise<void> => {
      setSavedIdentity(values);

      const formValues = form.state.values as AgentFormValues;
      const isTemplate = formValues.configuration === "from_template";
      const nextErrors: FormValidationErrors = {};

      if (isTemplate) {
        const template = formValues.template.selectedTemplate;
        if (!template) {
          setSaveMode(null);
          toast.error("Select a template before saving.");
          return;
        }
        const instances = formValues.template.agentInstances ?? [];
        const saveMode = mode === "deploy" ? "deploy" : "draft";
        const agentErrors = template
          ? collectTemplateAgentSaveErrors(template, instances, saveMode)
          : {};
        const managerErrors = orchestrationRequiresInlineManager(
          formValues.template.orchestrationPattern,
        )
          ? collectTemplateManagerSaveErrors(
              formValues.template.managerInstance,
              saveMode,
            )
          : {};
        if (Object.keys(agentErrors).length > 0 || Object.keys(managerErrors).length > 0) {
          setTemplateValidationByAgent(agentErrors);
          setManagerValidation(managerErrors);
          setSaveMode(null);
          toast.error("All required fields are not set.");
          return;
        }
        setTemplateValidationByAgent({});
        setManagerValidation({});
      } else if (formValues.configuration === "single") {
        if (!hasText(formValues.primaryModel)) {
          nextErrors.primaryModel =
            mode === "deploy"
              ? "Select a primary model to deploy the agent"
              : "Select a primary model to save the agent as draft";
        }

        if (!formValues.goal.trim()) {
          nextErrors.goal =
            mode === "deploy"
              ? "Configure the goal to deploy the agent"
              : "Configure the goal to save the agent as draft";
        }

        if (!formValues.instructions.trim()) {
          nextErrors.instructions =
            mode === "deploy"
              ? "Configure the instructions to deploy the agents"
              : "Configure the instructions to save the agent as draft";
        }

        const structuredOutputEnabled = formValues.enabledFeatures.includes("structured_output");
        if (structuredOutputEnabled) {
          const structuredOutputError = getStructuredOutputSaveError(
            formValues.featureConfig.structuredOutputSchema,
            formValues.featureConfig.responseFormat,
          );
          if (structuredOutputError) {
            nextErrors.structuredOutput = structuredOutputError;
          }
        }

        if (Object.keys(nextErrors).length > 0) {
          setValidationErrors(nextErrors);
          setSaveMode(null);
          const guidance = [
            nextErrors.primaryModel ? "Select a model in the Model section." : "",
            nextErrors.goal || nextErrors.instructions
              ? "Open the Profile section and click Save."
              : "",
            nextErrors.structuredOutput
              ? formValues.featureConfig.responseFormat === "text"
                ? "Open Configuration > Structured output, provide response guidelines, and save."
                : "Open Configuration > Structured output, provide a valid JSON Schema, and save."
              : "",
          ].filter(Boolean);
          toast.error(`${Object.values(nextErrors).join(" ")} ${guidance.join(" ")}`.trim());
          return;
        }
      }
      setValidationErrors({});

      // Template deploy: surface the unconfigured OPTIONAL dependencies that
      // will be skipped and require an explicit acknowledgment first.
      if (isTemplate && mode === "deploy") {
        const template = formValues.template.selectedTemplate;
        const instances = formValues.template.agentInstances ?? [];
        const skipped = template
          ? collectSkippedOptionalDependencies(template, instances)
          : [];
        if (skipped.length > 0) {
          setPendingDeployValues(values);
          setSkippedDeps(skipped);
          setSaveMode(null);
          setDeployConfirmOpen(true);
          return;
        }
      }

      await performSave(values, mode);
    },
    [form, performSave],
  );

  const navigateBack = useCallback(() => {
    navigate(returnTo ?? agentPaths.root);
  }, [navigate, returnTo]);

  const [resetCount, setResetCount] = useState(0);
  const handleReset = useCallback(() => {
    form.reset();
    setResetCount((c) => c + 1);
  }, [form]);

  const handlePreview = useCallback(() => {
    toast.info("Preview is not available yet.");
  }, []);

  const handleOpenTemplateDetails = useCallback(
    (template: AgentTemplateDefinition, kind: TemplateDetailsKind): void => {
      const content =
        kind === "examples"
          ? formatTemplateExamples(template.examples)
          : formatTemplateInstructions(template.instructions);
      setActiveTemplateDetails({ kind, content });
      setFocusedPanel(null);
    },
    [],
  );

  const handleCloseTemplateDetails = useCallback((): void => {
    setActiveTemplateDetails(null);
  }, []);

  return (
    <div className="dset-form-page dset-form-page--agent">
      <div className="dset-form-page__top-bar">
        <Typography
          Component="h1"
          fontSize="fs16"
          boldness="semibold"
          className="dset-form-page__top-bar-title"
        >
          {pageTitle}
        </Typography>
        <Button
          type="button"
          variant="icon"
          icon={<IconX size={20} />}
          onClick={navigateBack}
          aria-label="Close"
        />
      </div>

      <div className="agent-form-page__action-bar">
        <Typography
          Component="h2"
          fontSize="fs20"
          boldness="semibold"
          color="var(--text-primary)"
          className="agent-form-page__action-bar-subtitle"
        >
          {isEdit && savedIdentity.name ? savedIdentity.name : AGENT_STRINGS.PAGE_SUBTITLE}
        </Typography>
        <div className="agent-form-page__top-bar-actions">
          <Button
            type="button"
            variant="outline"
            size="medium"
            label="Reset"
            icon={<IconRefresh size={16} />}
            onClick={handleReset}
          />
          <Button
            type="button"
            variant="outline"
            size="medium"
            label="Preview"
            icon={<IconEye size={16} />}
            onClick={handlePreview}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={`${buttonVariants({ variant: "solid", size: "medium" })} agent-form-page__save-trigger`}
                >
                  <span className="btn-icon">
                    <IconPlus size={16} />
                  </span>
                  <span className="btn-label">Save</span>
                  <span className="btn-icon agent-form-page__save-trigger-chevron">
                    <IconChevronDown size={16} />
                  </span>
                </button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!canSaveDraft || hasBlockingUnresolvedDependencies}
                onClick={() => handleOpenSaveDialog("draft")}
              >
                {SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AS_DRAFT}
              </DropdownMenuItem>
              <DropdownMenuItem
                className={LOCK_AGENT_DEPLOY ? DEPLOY_LOCKED_CLASS : undefined}
                aria-disabled={LOCK_AGENT_DEPLOY || undefined}
                disabled={LOCK_AGENT_DEPLOY ? undefined : (hasBlockingUnresolvedDependencies || !canDeploy)}
                onClick={(event) => {
                  // True lock: block keyboard/programmatic activation too, not
                  // just the mouse (CSS pointer-events). QA can unlock in devtools
                  // by removing the --locked class on this item.
                  if (isDeployActivationLocked(event.currentTarget)) return;
                  // Devtools-unlock lifts only the lock; the dependency/validation
                  // gate must still block Save-and-deploy when it would normally
                  // be disabled.
                  if (hasBlockingUnresolvedDependencies || !canDeploy) return;
                  handleOpenSaveDialog("deploy");
                }}
              >
                {SAVE_AGENT_DIALOG_STRINGS.TRIGGER_SAVE_AND_DEPLOY}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="dset-form-page__body">
        <div className="dset-form-page__body-inner">
          <div
            className={
              focusedPanel
                ? `agent-form__workbench agent-form__workbench--focused agent-form__workbench--focused-${focusedPanel}`
                : showRunDetails
                  ? "agent-form__workbench"
                  : "agent-form__workbench agent-form__workbench--two-col"
            }
          >
            <Card
              className={
                isPanelHidden("config")
                  ? "agent-form__config-card agent-form__panel--hidden"
                  : "agent-form__config-card"
              }
            >
              <CardHeader
                icon={<IconBox size={20} />}
                title="Agent configuration"
                hasSeparator
                actions={[renderPanelExpandAction("config", "Agent configuration")]}
              />
              <CardContent>
                <Form form={form}>
                  <div className="agent-form__config-body">
                    <SetupSection form={form} />

                    {configuration === "single" && (
                      <>
                        <ModelSection
                          form={form}
                          primaryModelError={validationErrors.primaryModel}
                        />
                        <ProfileSection
                          form={form}
                          validationErrors={{
                            goal: validationErrors.goal,
                            instructions: validationErrors.instructions,
                          }}
                        />
                        <KnowledgeBasesSection
                          form={form}
                          kbRequirements={requirements?.knowledgeBases}
                          errorMessage={validationErrors.knowledgeBases}
                        />
                        <ToolsetSection
                          form={form}
                          mcpRequirements={requirements?.mcpServers}
                          errorMessage={validationErrors.toolsets}
                        />
                        <ConfigurationSection
                          key={resetCount}
                          form={form}
                          structuredOutputError={validationErrors.structuredOutput}
                        />
                      </>
                    )}

                    {configuration === "team" && (
                      <>
                        <TeamConfigSection form={form} />
                        <TeamAgentsSection form={form} />
                        <TeamTeamsSection
                          form={form}
                          currentTeamId={isEdit ? agentId : undefined}
                        />
                      </>
                    )}

                    {configuration === "from_template" && (
                      <>
                        <TemplateSection
                          form={form}
                          onOpenDetails={handleOpenTemplateDetails}
                        />
                        <TemplateAgentsSection
                          form={form}
                          validationErrorsByAgent={templateValidationByAgent}
                          managerValidationErrors={managerValidation}
                        />
                      </>
                    )}
                  </div>
                </Form>
              </CardContent>
            </Card>

            <div
              className={
                isPanelHidden("chat")
                  ? "agent-form__panel-slot agent-form__panel--hidden"
                  : "agent-form__panel-slot"
              }
            >
              <PlaygroundChatPanel
                messages={messages}
                isLoading={isStreaming}
                onSendMessage={sendMessage}
                disabled={!playgroundReadiness.ready}
                emptyMessage={playgroundReadiness.reason ?? undefined}
                headerActions={[
                  renderShowDetailsAction(),
                  renderPanelExpandAction("chat", "Chat"),
                ]}
                modelLookup={modelLookup}
                agentActivity={liveAgentActivity}
              />
            </div>

            <div
              className={
                isPanelHidden("run")
                  ? "agent-form__panel-slot agent-form__panel--hidden"
                  : "agent-form__panel-slot"
              }
            >
              <RunDetailsPanel
                agentId={isEdit ? (agentId ?? null) : null}
                selectedSessionId={selectedSessionId}
                onSessionChange={handleSessionChange}
                pendingSessionIds={pendingSessionIds}
                isChatLoading={isStreaming}
                lastRunMetrics={lastRunMetrics}
                liveExecutionSteps={liveExecutionSteps}
                displayConfig={displayConfig}
                modelLookup={modelLookup}
                headerActions={[renderPanelExpandAction("run", "Run details")]}
              />
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={configuration === "from_template" && activeTemplateDetails !== null}
        onOpenChange={(open) => {
          if (!open) handleCloseTemplateDetails();
        }}
        container={templateDetailsContainer}
      >
        <DialogPopup showCloseButton={false} className="agent-form__template-drawer">
          <div className="agent-form__template-drawer-inner">
            <header className="agent-form__template-drawer-header">
              <DialogTitle className="agent-form__template-drawer-title">
                {renderedTemplateDetails?.kind === "examples" ? "Examples" : "Instructions"}
              </DialogTitle>
              <Button
                type="button"
                variant="icon"
                size="small"
                icon={<IconX size={16} />}
                onClick={handleCloseTemplateDetails}
                aria-label="Close template details"
              />
            </header>
            <div className="agent-form__template-drawer-content">
              <Typography
                Component="p"
                fontSize="fs14"
                color="var(--text-secondary)"
                className="agent-form__template-details-content"
              >
                {renderedTemplateDetails?.content}
              </Typography>
            </div>
          </div>
        </DialogPopup>
      </Dialog>

      <ConfirmDialog
        open={isBlocked}
        title="Discard changes?"
        description="You have unsaved changes. Are you sure you want to leave?"
        confirmLabel="Discard"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />

      <SaveAgentDialog
        key={saveMode ?? "closed"}
        open={saveMode !== null}
        mode={saveMode ?? "draft"}
        initialValues={savedIdentity}
        unresolvedDependencies={unresolvedDependencies}
        onClose={handleCloseSaveDialog}
        onSubmit={handleConfirmSave}
      />

      <DeployConfirmationDialog
        open={deployConfirmOpen}
        skippedDependencies={skippedDeps}
        onClose={() => {
          setDeployConfirmOpen(false);
          setPendingDeployValues(null);
        }}
        onConfirm={() => {
          setDeployConfirmOpen(false);
          if (pendingDeployValues) {
            void performSave(pendingDeployValues, "deploy");
          }
          setPendingDeployValues(null);
        }}
      />
    </div>
  );
}

export { AgentForm };
export type { AgentFormProps };
