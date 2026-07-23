// Workflow registry for the eval-worker bundle (spec §6.2).
//
// Only ONE workflow is registered: the flat AgentEvaluationWorkflow. Per-case
// work is dispatched by an inline `runCase` helper inside the parent — it is
// NOT a child Temporal workflow and is therefore not registered here. All run
// modes (single, regression, A/B, repeats) are composition patterns driven by
// config-service.

export {
  AgentEvaluationWorkflow,
  evaluationProgressQuery,
  evaluationResultsQuery,
  evaluationPreflightQuery,
  evaluationCancelSignal,
  evaluationTradeoffSignal,
  evaluationOverrideSignal,
} from './agent-evaluation.workflow';
