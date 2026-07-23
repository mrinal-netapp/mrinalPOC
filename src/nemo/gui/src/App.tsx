import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import { TabProvider } from './contexts/TabContext'
import { ToastProvider } from './contexts/ToastContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { setAuthTokenGetter } from './services/api'
import { setMetricsAuthTokenGetter } from './services/metricsApi'
import { Spinner } from '@fluentui/react-components'

// Lazy load page components for code splitting
const Home = lazy(() => import('./pages/Home'))
const ProjectList = lazy(() => import('./pages/ProjectList'))
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'))
const ProjectDataSources = lazy(() => import('./pages/ProjectDataSources'))
const ProjectStreams = lazy(() => import('./pages/ProjectStreams'))
const ProjectTables = lazy(() => import('./pages/ProjectTables'))
const ProjectCredentials = lazy(() => import('./pages/ProjectCredentials'))
const ProjectLineage = lazy(() => import('./pages/ProjectLineage'))
const ProjectDatasets = lazy(() => import('./pages/ProjectDatasets'))
const DatasetDetail = lazy(() => import('./pages/DatasetDetail'))
const PipelineListPage = lazy(() => import('./pages/PipelineListPage'))
const ProjectKnowledgeBases = lazy(() => import('./pages/ProjectKnowledgeBases'))
const KnowledgeBaseDetail = lazy(() => import('./pages/KnowledgeBaseDetail'))
const ProjectMCPServers = lazy(() => import('./pages/ProjectMCPServers'))
const MCPServerDetail = lazy(() => import('./pages/MCPServerDetail'))
const ProjectModels = lazy(() => import('./pages/ProjectModels'))
const ModelPlayground = lazy(() => import('./pages/ModelPlayground'))
const ProviderDetail = lazy(() => import('./pages/ProviderDetail'))
const ProjectAgents = lazy(() => import('./pages/ProjectAgents'))
const AgentChat = lazy(() => import('./pages/AgentChat'))
const AgentTeamChat = lazy(() => import('./pages/AgentTeamChat'))
const AgentChatDemo = lazy(() => import('./pages/AgentChatDemo'))
const AgentPlayground = lazy(() => import('./pages/AgentPlayground'))
const ProjectPipelineExecutions = lazy(() => import('./pages/ProjectPipelineExecutions'))
const PipelineRunDetail = lazy(() => import('./pages/PipelineRunDetail'))
const PipelineEditor = lazy(() => import('./pages/PipelineEditor'))
const RayExplorer = lazy(() => import('./pages/RayExplorer'))
const S3Explorer = lazy(() => import('./pages/S3Explorer'))
const DeploymentList = lazy(() => import('./pages/DeploymentList'))
const DeploymentDetail = lazy(() => import('./pages/DeploymentDetail'))
const WorkflowDetail = lazy(() => import('./pages/WorkflowDetail'))
const ProjectDashboard = lazy(() => import('./pages/ProjectDashboard'))
const CostDashboard = lazy(() => import('./pages/CostDashboard'))
const InfraDashboard = lazy(() => import('./pages/InfraDashboard'))
const Settings = lazy(() => import('./pages/Settings'))
const Login = lazy(() => import('./pages/Login'))
const FirstTimeSetup = lazy(() => import('./pages/FirstTimeSetup'))
const AuthCallback = lazy(() => import('./pages/AuthCallback'))
const SilentCallback = lazy(() => import('./pages/SilentCallback'))

// Loading fallback component
const LoadingFallback = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
    <Spinner label="Loading..." />
  </div>
)

// Protected Route component
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return <LoadingFallback />
  }

  if (!isAuthenticated) {
    // Redirect to login with return URL
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}

// Component to initialize API client with auth token getters
const ApiClientInitializer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { getAccessToken, refreshToken } = useAuth()

  useEffect(() => {
    // Initialize API client with token getters
    setAuthTokenGetter(getAccessToken, refreshToken)
    setMetricsAuthTokenGetter(getAccessToken)
  }, [getAccessToken, refreshToken])

  return <>{children}</>
}

function App() {
  // Get base path from environment variable or use default
  // This should match VITE_BASE_PATH used in vite.config.ts
  // When deployed behind gateway at /console, set VITE_BASE_PATH=/console
  // React Router expects base path without trailing slash (except root)
  let basePath = import.meta.env.VITE_BASE_PATH || '/'
  if (basePath !== '/' && basePath.endsWith('/')) {
    basePath = basePath.slice(0, -1)
  }
  
  return (
    <BrowserRouter basename={basePath}>
      <AuthProvider>
        <ApiClientInitializer>
      <ToastProvider>
        <TabProvider>
            <Suspense fallback={<LoadingFallback />}>
              <Routes>
                  {/* Public routes */}
                  <Route path="/setup" element={<FirstTimeSetup />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/auth/callback" element={<AuthCallback />} />
                  <Route path="/auth/silent-callback" element={<SilentCallback />} />
                  
                  {/* Protected routes */}
                  <Route path="/" element={
                    <ProtectedRoute>
                      <Layout>
                        <Home />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectList />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectDetail />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  {/* Data Sources landing and sub-pages */}
                  <Route path="/projects/:projectId/datasources" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectDataSources />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/datasources/volumes" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectDataSources />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/datasources/connectors" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectDataSources />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/datasources/credentials" element={
                    <Navigate to="../../credentials" replace />
                  } />
                  <Route path="/projects/:projectId/credentials" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectCredentials />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/lineage" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectLineage />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  {/* Redirects from old routes */}
                  <Route path="/projects/:projectId/buckets" element={<Navigate to="../datasources" replace />} />
                  <Route path="/projects/:projectId/connectors" element={<Navigate to="../datasources" replace />} />
                  <Route path="/projects/:projectId/streams" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectStreams />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/databases" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectTables />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/datasets" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectDatasets />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/datasets/:datasetId" element={
                    <ProtectedRoute>
                      <Layout>
                        <DatasetDetail />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/pipelines" element={
                    <ProtectedRoute>
                      <Layout>
                        <PipelineListPage />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/pipelines/data" element={<Navigate to={{ pathname: '../pipelines', search: '?type=Data' }} replace />} />
                  <Route path="/projects/:projectId/pipelines/api" element={<Navigate to={{ pathname: '../pipelines', search: '?type=API' }} replace />} />
                  <Route path="/projects/:projectId/knowledgebases" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectKnowledgeBases />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/knowledgebases/:kbId" element={
                    <ProtectedRoute>
                      <Layout>
                        <KnowledgeBaseDetail />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/workflows/:workflowId" element={
                    <ProtectedRoute>
                      <Layout>
                        <WorkflowDetail />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/mcp-servers" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectMCPServers />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/mcp-servers/:serverId" element={
                    <ProtectedRoute>
                      <Layout>
                        <MCPServerDetail />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/models" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectModels />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/models/provider/:provider" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProviderDetail />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/models/playground" element={
                    <ProtectedRoute>
                      <Layout>
                        <ModelPlayground />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/agents" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectAgents />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/agents/playground" element={
                    <ProtectedRoute>
                      <Layout>
                        <AgentPlayground />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/agents/demo/chat" element={
                    <ProtectedRoute>
                      <Layout>
                        <AgentChatDemo />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/agents/:agentId/chat" element={
                    <ProtectedRoute>
                      <Layout>
                        <AgentChat />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/agent-teams/:teamId/chat" element={
                    <ProtectedRoute>
                      <Layout>
                        <AgentTeamChat />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/pipelines/executions" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectPipelineExecutions />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/pipelines/:pipelineId/executions/:executionId" element={
                    <ProtectedRoute>
                      <Layout>
                        <PipelineRunDetail />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/pipelines/:pipelineType/editor" element={
                    <ProtectedRoute>
                      <Layout>
                        <PipelineEditor />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/pipelines/:pipelineType/editor/:pipelineId" element={
                    <ProtectedRoute>
                      <Layout>
                        <PipelineEditor />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/rays" element={
                    <ProtectedRoute>
                      <Layout>
                        <RayExplorer />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/dashboard" element={
                    <ProtectedRoute>
                      <Layout>
                        <ProjectDashboard />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/cost" element={
                    <ProtectedRoute>
                      <Layout>
                        <CostDashboard />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/infrastructure" element={
                    <ProtectedRoute>
                      <Layout>
                        <InfraDashboard />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/projects/:projectId/s3" element={
                    <ProtectedRoute>
                      <Layout>
                        <S3Explorer />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/deployments" element={
                    <ProtectedRoute>
                      <Layout>
                        <DeploymentList />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/deployments/:deploymentId" element={
                    <ProtectedRoute>
                      <Layout>
                        <DeploymentDetail />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  <Route path="/settings" element={
                    <ProtectedRoute>
                      <Layout>
                        <Settings />
                      </Layout>
                    </ProtectedRoute>
                  } />
                  
                  {/* Catch all - redirect to home */}
                  <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
        </TabProvider>
      </ToastProvider>
        </ApiClientInitializer>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App

