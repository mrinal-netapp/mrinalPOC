export const ROUTES = {
  HOME: "/",
  OVERVIEW: "overview",
  OBSERVABILITY: "observability",
  DATA_MANAGEMENT: "data-management",
  KNOWLEDGE_BASES: "knowledge-bases",
  TOOLSET: "toolsets",
  TOOLSET_ADD_TOOL: "add-toolset",
  TOOLSET_DETAIL_PARAM: ":toolId",
  /** Dev / internal: RTK Query smoke-test page for KB endpoints */
  JOBS: "jobs",
  MODELS: "models",
  /** Add-model multi-step onboarding flow. */
  MODELS_ADD: "add",
  /** Dynamic segment for a single model detail page. */
  MODEL_DETAIL_PARAM: ":modelId",
  CREDENTIALS: "credentials",
  CRED_DETAIL_PARAM: ":credId",
  CRED_ROTATE: "rotate",
  CONFIGURATIONS: "configurations",
  CHATBOT: "chatbot",
  EVALUATIONS: "evaluations",
  /** Dynamic segment for a single evaluation template detail page. */
  EVAL_DETAIL_PARAM: ":templateId",
  ADMINISTRATION: "administration",
  PROJECTS: "projects",
  PROJECT_DETAIL_PARAM: ":projectId",
  NOT_FOUND: "*",
  AGENTS: "agents",

  // Data Management sub-routes
  DATA_SOURCES: "data-sources",
  DATASETS: "datasets",
  CREATE: "create",
  EDIT: "edit",
  DETAIL_PARAM: ":dsrcId",
  DSET_DETAIL_PARAM: ":dsetId",
  KB_DETAIL_PARAM: ":kbId",

  AGENT_DETAIL_PARAM: ":agentId",
  AGENT_PLAYGROUND: "playground",
  AGENT_PLAYGROUND_WORKSPACE: "workspace",
} as const;

/** Absolute paths for `navigate()` / `<Link to>` (router root; respects basename). */
export const ROUTE_PATHS = {
  OVERVIEW: `/${ROUTES.OVERVIEW}`,
} as const;
