package middleware

// buildPolicyTable maps each workflow-engine route (METHOD + gin FullPath) to
// its guard policy.
//
// Lanes (simplified mesh-first model):
//   - public : no credentials (progress endpoints — workers/self call tokenless).
//   - user   : every other route. When a JWT carries an email claim the guard
//     sets userClaims and identity headers (handlers keep their own checks).
//     Token-less / no-email callers pass via `!email → next()` on ANY policy.
//
// Because services pass via !email regardless, there is no user/service/dual
// distinction at the app layer. The !email check covers tokenless callers
// (post-PR#249) and SA tokens (pre-PR#249) uniformly.
//
// HARDENING DEFERRED: re-blocking JWT users from the service-only paths is NOT
// part of this PR. Until a follow-up adds a `deny-jwt-on-workflow-engine-*`
// mesh AuthorizationPolicy, a JWT user could reach these routes at the app
// layer (handler-level checks such as requireProjectAdmin still apply).
func buildPolicyTable() map[string]routePolicy {
	user := routePolicy{user: true}
	public := routePolicy{public: true}

	return map[string]routePolicy{
		// ── Public: progress store (tokenless — workers + WE self + config poll)
		"GET /api/v1/workflows/:workflowId/progress":    public,
		"POST /api/v1/workflows/:workflowId/progress":   public,
		"DELETE /api/v1/workflows/:workflowId/progress": public,

		// ── User lane (UI direct or config-service forwarding the user RPT)
		"POST /api/v1/projects/:projectId/init":                                              user,
		"POST /api/v1/projects/:projectId/members":                                           user,
		"DELETE /api/v1/projects/:projectId/members":                                         user,
		"PUT /api/v1/projects/:projectId/members/role":                                       user,
		"POST /api/v1/projects/:projectId/knowledgebases/:kbId/terminate":                    user,
		"DELETE /api/v1/projects/:projectId/knowledgebases/:kbId":                            user,
		"GET /api/v1/projects/:projectId/knowledgebases/:kbId/versions":                      user,
		"POST /api/v1/projects/:projectId/knowledgebases/:kbId/versions/:versionId/rollback": user,
		"POST /api/v1/connectors/volume-browse":                                              user,
		"POST /api/v1/projects/:projectId/connectors/:connectorId/test":                      user,
		"GET /api/v1/projects/:projectId/connectors/:connectorId/discover":                   user,
		"POST /api/v1/projects/:projectId/connectors/:connectorId/preview":                   user,
		"GET /api/v1/workflows/:workflowId/status":                                           user,
		"GET /api/v1/workflows/:workflowId/result":                                           user,
		"GET /api/v1/workflows/:workflowId/logs":                                             user,

		// ── UI user OR service callback (token-less service passes via !email)
		"POST /api/v1/projects/:projectId/datasets/:datasetId/acquire": user,
		"POST /api/v1/projects/:projectId/knowledgebases/:kbId/create": user,
		"POST /api/v1/workflows/:workflowId/cancel":                    user,
		"POST /api/v1/explore/session":                                 user,
		"POST /api/v1/explore/session/:sessionId/list":                 user,

		// ── Service-only routes — `user` at the app layer; token-less services
		//    pass via !email. Re-blocking JWT users on these paths at the mesh is
		//    deferred to a follow-up hardening PR (see buildPolicyTable header).
		"DELETE /api/v1/projects/:projectId/delete":                                             user,
		"POST /api/v1/projects/:projectId/datasets/:datasetId/import":                           user,
		"POST /api/v1/projects/:projectId/datasets/:datasetId/process":                          user,
		"POST /api/v1/projects/:projectId/datasets/:datasetId/terminate":                        user,
		"DELETE /api/v1/projects/:projectId/datasets/:datasetId":                                user,
		"POST /api/v1/projects/:projectId/datasets/:datasetId/schedule":                         user,
		"DELETE /api/v1/projects/:projectId/datasets/:datasetId/schedule":                       user,
		"GET /api/v1/projects/:projectId/datasets/:datasetId/schedule":                          user,
		"POST /api/v1/projects/:projectId/knowledgebases/:kbId/schedule":                        user,
		"DELETE /api/v1/projects/:projectId/knowledgebases/:kbId/schedule":                      user,
		"POST /api/v1/projects/:projectId/pipelines/:pipelineId/terminate":                      user,
		"POST /api/v1/projects/:projectId/pipelines/:pipelineId/schedule":                       user,
		"DELETE /api/v1/projects/:projectId/pipelines/:pipelineId/schedule":                     user,
		"GET /api/v1/projects/:projectId/pipelines/:pipelineId/schedule":                        user,
		"POST /api/v1/projects/:projectId/pipelines/:pipelineId/executions":                     user,
		"GET /api/v1/projects/:projectId/pipelines/:pipelineId/executions":                      user,
		"GET /api/v1/projects/:projectId/pipelines/:pipelineId/executions/:executionId":         user,
		"POST /api/v1/projects/:projectId/pipelines/:pipelineId/executions/:executionId/cancel": user,
		"POST /api/v1/projects/:projectId/pipelines/:pipelineId/executions/:executionId/resume": user,
		"POST /api/v1/projects/:projectId/connectors/:connectorId/terminate":                    user,
		"POST /api/v1/connectors/volume-scan":                                                   user,
		"POST /api/v1/explore/cache/invalidate":                                                 user,
		"POST /api/v1/workflows":                                                                user,
		"POST /api/v1/workflows/:workflowId/query/:queryName":                                   user,
		"POST /api/v1/workflows/:workflowId/signal/:signalName":                                 user,
		"POST /api/v1/reference-edges/schedule":                                                 user,
		"DELETE /api/v1/reference-edges/schedule":                                               user,
		"GET /api/v1/reference-edges/schedule":                                                  user,
		"POST /api/v1/mcp-health/schedule":                                                      user,
		"DELETE /api/v1/mcp-health/schedule":                                                    user,
		"GET /api/v1/mcp-health/schedule":                                                       user,
	}
}
