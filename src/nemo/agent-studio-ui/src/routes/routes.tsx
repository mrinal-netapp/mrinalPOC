import { Navigate, redirect, type RouteObject } from "react-router";
import { App } from "@/App";
import { AppAuthGate } from "@/contexts/auth/guards/AppAuthGate";
import { ProjectGuard } from "@/contexts/project";
import { AuthCallbackPage } from "@/routes/pages/auth/auth-callback-page";
import { AuthLogoutCallbackPage } from "@/routes/pages/auth/auth-logout-callback-page";
import { AuthSilentCallbackPage } from "@/routes/pages/auth/auth-silent-callback-page";
import { ChatbotPage } from "@/routes/pages/chatbot/chatbot-page";
import { OverviewPage } from "@/routes/pages/overview/overview-page";
import { DataSourcePage } from "@/routes/pages/data-management/data-source/data-source-page";
import { ObservabilityPage } from "@/routes/pages/observability/observability-page";
import { DataSourceCreatePage } from "@/routes/pages/data-management/data-source/create-edit/data-source-create-page";
import { DataSourceEditPage } from "@/routes/pages/data-management/data-source/create-edit/data-source-edit-page";
import { DataSourceDetail } from "@/routes/pages/data-management/data-source/detail/data-source-detail";
import { DatasetPage } from "@/routes/pages/data-management/dataset/dataset-page";
import { DatasetCreatePage } from "@/routes/pages/data-management/dataset/create-edit/dataset-create-page";
import { DatasetEditPage } from "@/routes/pages/data-management/dataset/create-edit/dataset-edit-page";
import { DatasetDetail } from "@/routes/pages/data-management/dataset/detail/dataset-detail";
import { KBListPage } from "@/routes/pages/knowledge-base/list/kb-list-page";
import { KBCreatePage } from "@/routes/pages/knowledge-base/create-edit/kb-create-page";
import { KBEditPage } from "@/routes/pages/knowledge-base/create-edit/kb-edit-page";
import { KBDetail } from "@/routes/pages/knowledge-base/detail/kb-detail";
import { AdministrationPage } from "@/routes/pages/administration/administration-page";
import { ProjectsLayout } from "@/routes/pages/projects/layout/projects-layout";
import { ProjectsListPage } from "@/routes/pages/projects/list/projects-list-page";
import { ProjectCreatePage } from "@/routes/pages/projects/create-edit/project-create-page";
import { ProjectEditPage } from "@/routes/pages/projects/create-edit/project-edit-page";
import { AddToolPage } from "@/routes/pages/toolset/add-tool/add-tool-page";
import { ToolsetDetailPage } from "@/routes/pages/toolset/detail/toolset-detail-page";
import { ToolsetEditPage } from "@/routes/pages/toolset/edit/toolset-edit-page";
import { ToolsetPage } from "@/routes/pages/toolset/toolset-page";
import { ROUTES } from "./routes.consts";
import { ModelsPage } from "@/routes/pages/models/models-page";
import { AddModelPage } from "@/routes/pages/models/add-model-page";
import { ModelDetailPage } from "@/routes/pages/models/model-detail-page";
import { ModelEditPage } from "@/routes/pages/models/model-edit-page";
import { CredentialsPage } from "@/routes/pages/credentials/credentials-page";
import { CredentialCreatePage } from "@/routes/pages/credentials/create-edit/credential-create-page";
import { CredentialEditPage } from "@/routes/pages/credentials/create-edit/credential-edit-page";
import { CredentialRotatePage } from "@/routes/pages/credentials/rotate/credential-rotate-page";
import { AgentsPage } from "@/routes/pages/agents/agents-page";
import { AgentDetailPage } from "@/routes/pages/agents/agent-detail-page";
import { AgentCreatePage } from "@/routes/pages/agents/create-edit/agent-create-page";
import { AgentPlaygroundWorkspacePage } from "@/routes/pages/agents/playground/agent-playground-workspace-page";
import { LegacyDataManagementRedirect } from "./legacy-redirects";
import { EvalListPage } from "@/routes/pages/evaluations/list/eval-list-page";
import { EvalCreatePage } from "@/routes/pages/evaluations/create-edit/eval-create-page";
import { EvalEditPage } from "@/routes/pages/evaluations/create-edit/eval-edit-page";
import { EvalDetailPage } from "@/routes/pages/evaluations/detail/eval-detail-page";

export const routes: RouteObject[] = [
  {
    path: ROUTES.HOME,
    children: [
      {
        path: "auth/callback",
        element: <AuthCallbackPage />,
      },
      {
        path: "auth/silent-callback",
        element: <AuthSilentCallbackPage />,
      },
      {
        path: "auth/logout-callback",
        element: <AuthLogoutCallbackPage />,
      },
      {
        element: <AppAuthGate />,
        children: [
          {
            element: <App />,
            children: [
              {
                index: true,
                element: <Navigate to={ROUTES.OVERVIEW} replace />,
              },
              {
                path: ROUTES.OVERVIEW,
                element: <OverviewPage />,
              },
              {
                path: ROUTES.OBSERVABILITY,
                element: <ObservabilityPage />,
              },
              {
                path: ROUTES.DATA_SOURCES,
                children: [
                  { index: true, element: <DataSourcePage /> },
                  { path: ROUTES.CREATE, element: <DataSourceCreatePage /> },
                  { path: ROUTES.DETAIL_PARAM, element: <DataSourceDetail /> },
                  { path: `${ROUTES.DETAIL_PARAM}/${ROUTES.EDIT}`, element: <DataSourceEditPage /> },
                ],
              },
              // Legacy redirect: /data-management/* (and bare /data-management)
              // routes were folded into top-level /data-sources and /datasets.
              // Keep this so bookmarked URLs don't 404. Splat preserves the
              // trailing path (e.g. /data-management/data-sources/abc → /data-sources/abc).
              {
                path: ROUTES.DATA_MANAGEMENT,
                loader: () => redirect(`/${ROUTES.DATA_SOURCES}`),
              },
              {
                path: `${ROUTES.DATA_MANAGEMENT}/*`,
                loader: ({ params }) => redirect(`/${params["*"] ?? ROUTES.DATA_SOURCES}`),
              },
              {
                path: ROUTES.DATASETS,
                children: [
                  { index: true, element: <DatasetPage /> },
                  { path: ROUTES.CREATE, element: <DatasetCreatePage /> },
                  { path: ROUTES.DSET_DETAIL_PARAM, element: <DatasetDetail /> },
                  { path: `${ROUTES.DSET_DETAIL_PARAM}/${ROUTES.EDIT}`, element: <DatasetEditPage /> },
                ],
              },
              {
                path: ROUTES.DATA_MANAGEMENT,
                children: [
                  {
                    index: true,
                    element: <Navigate to={`/${ROUTES.DATA_SOURCES}`} replace />,
                  },
                  {
                    // Legacy deep links: /data-management/<rest> → /<rest>
                    path: "*",
                    element: <LegacyDataManagementRedirect />,
                  },
                ],
              },
              {
                path: ROUTES.KNOWLEDGE_BASES,
                children: [
                  {
                    index: true,
                    element: <KBListPage />,
                  },
                  {
                    path: `${ROUTES.CREATE}`,
                    element: <KBCreatePage />,
                  },
                  {
                    path: `${ROUTES.KB_DETAIL_PARAM}/${ROUTES.EDIT}`,
                    element: <KBEditPage />,
                  },
                  {
                    path: ROUTES.KB_DETAIL_PARAM,
                    element: <KBDetail />,
                  },
                ],
              },
              {
                path: ROUTES.JOBS,
                element: <div>Jobs</div>,
              },
              {
                path: ROUTES.TOOLSET,
                children: [
                  {
                    index: true,
                    element: <ToolsetPage />,
                  },
                  {
                    path: ROUTES.TOOLSET_ADD_TOOL,
                    element: <AddToolPage />,
                  },
                  {
                    path: ROUTES.TOOLSET_DETAIL_PARAM,
                    element: <ToolsetDetailPage />,
                  },
                  {
                    path: `${ROUTES.TOOLSET_DETAIL_PARAM}/${ROUTES.EDIT}`,
                    element: <ToolsetEditPage />,
                  },
                ],
              },
              {
                path: ROUTES.MODELS,
                element: <ModelsPage />,
              },
              {
                // Static segments MUST come BEFORE the `:modelId` route so
                // react-router doesn't match "add" as a model id.
                path: `${ROUTES.MODELS}/${ROUTES.MODELS_ADD}`,
                element: <AddModelPage />,
              },
              {
                path: `${ROUTES.MODELS}/${ROUTES.MODEL_DETAIL_PARAM}`,
                element: <ModelDetailPage />,
              },
              {
                path: `${ROUTES.MODELS}/${ROUTES.MODEL_DETAIL_PARAM}/${ROUTES.EDIT}`,
                element: <ModelEditPage />,
              },
              {
                path: ROUTES.CREDENTIALS,
                children: [
                  {
                    index: true,
                    element: <CredentialsPage />,
                  },
                  {
                    path: ROUTES.CREATE,
                    element: <CredentialCreatePage />,
                  },
                  {
                    path: `${ROUTES.CRED_DETAIL_PARAM}/${ROUTES.EDIT}`,
                    element: <CredentialEditPage />,
                  },
                  {
                    path: `${ROUTES.CRED_DETAIL_PARAM}/${ROUTES.CRED_ROTATE}`,
                    element: <CredentialRotatePage />,
                  },
                ],
              },
              {
                path: ROUTES.CONFIGURATIONS,
                element: <div>Configurations</div>,
              },
              {
                path: ROUTES.CHATBOT,
                element: (
                  <ProjectGuard
                    requiredRoles={["admin", "member"]}
                    fallback={<Navigate to={`/${ROUTES.OVERVIEW}`} replace />}
                  >
                    <ChatbotPage />
                  </ProjectGuard>
                ),
              },
              {
                path: ROUTES.EVALUATIONS,
                children: [
                  {
                    index: true,
                    element: <EvalListPage />,
                  },
                  {
                    path: ROUTES.CREATE,
                    element: <EvalCreatePage />,
                  },
                  {
                    // Edit declared before the bare :templateId detail route so
                    // "create" and ":templateId/edit" aren't captured as template IDs.
                    path: `${ROUTES.EVAL_DETAIL_PARAM}/${ROUTES.EDIT}`,
                    element: <EvalEditPage />,
                  },
                  {
                    path: ROUTES.EVAL_DETAIL_PARAM,
                    element: <EvalDetailPage />,
                  },
                ],
              },
              {
                path: ROUTES.ADMINISTRATION,
                element: <AdministrationPage />,
              },
              {
                path: ROUTES.PROJECTS,
                element: <ProjectsLayout />,
                children: [
                  {
                    index: true,
                    element: <ProjectsListPage />,
                  },
                  {
                    path: ROUTES.CREATE,
                    element: <ProjectCreatePage />,
                  },
                  {
                    path: `${ROUTES.PROJECT_DETAIL_PARAM}/${ROUTES.EDIT}`,
                    element: <ProjectEditPage />,
                  },
                ],
              },
              {
                path: ROUTES.AGENTS,
                children: [
                  {
                    index: true,
                    element: <AgentsPage />,
                  },
                  {
                    path: ROUTES.CREATE,
                    element: <AgentCreatePage />,
                  },
                  {
                    path: `${ROUTES.AGENT_DETAIL_PARAM}/${ROUTES.EDIT}`,
                    element: <AgentCreatePage />,
                  },
                  {
                    path: ROUTES.AGENT_DETAIL_PARAM,
                    element: <AgentDetailPage />,
                  },
                ],
              },
              {
                path: ROUTES.AGENT_PLAYGROUND,
                children: [
                  {
                    path: `${ROUTES.AGENT_PLAYGROUND_WORKSPACE}/${ROUTES.AGENT_DETAIL_PARAM}`,
                    element: <AgentPlaygroundWorkspacePage />,
                  },
                ],
              },
              {
                path: ROUTES.NOT_FOUND,
                element: <div>404 — Page not found</div>,
              },
            ],
          },
        ],
      },
    ],
  },
];
