import { describe, expect, it, beforeEach, afterEach } from "vitest"
import type { Mock } from "vitest"

import { createMockStore } from "@test/mocks"
import { mockFetchSuccess, mockFetchError, restoreAllMocks } from "@test/api-mock"
import { evalApi } from "./eval-api.slice"

type TestStore = ReturnType<typeof createMockStore>

const PROJECT_ID = "proj-test"

function calledUrl(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0]
  if (typeof arg === "string") return arg
  return arg?.url ?? String(arg)
}

function calledMethod(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0]
  return arg?.method ?? "GET"
}

const TEMPLATE_LIST = [
  { templateId: "evt-1", evalName: "Eval One", runCount: 2 },
  { templateId: "evt-2", evalName: "Eval Two", runCount: 0 },
]

const TEMPLATE_DETAIL = { templateId: "evt-1", evalName: "Eval One" }

const RUN_LIST = [
  { runId: "run-1", templateId: "evt-1", name: "Run 1", status: "completed" },
  { runId: "run-2", templateId: "evt-1", name: "Run 2", status: "failed" },
]

const RUN_DETAIL = { runId: "run-1", templateId: "evt-1", name: "Run 1", status: "completed" }

describe("evalApi", () => {
  let store: TestStore

  beforeEach(() => {
    store = createMockStore()
  })

  afterEach(() => {
    store.dispatch(evalApi.util.resetApiState())
    restoreAllMocks()
  })

  // -- Templates --

  describe("listEvaluations", () => {
    it("[tag:eval-api] GETs templates and provides LIST + per-item tags", async () => {
      mockFetchSuccess(TEMPLATE_LIST)

      await store.dispatch(evalApi.endpoints.listEvaluations.initiate({ projectId: PROJECT_ID, limit: 10 }))

      const tags = store.getState().api.provided.tags
      expect(tags.EvalTemplate?.LIST).toBeDefined()
      expect(tags.EvalTemplate?.["evt-1"]).toBeDefined()
      expect(tags.EvalTemplate?.["evt-2"]).toBeDefined()
    })

    it("[tag:eval-api] GETs templates without optional params", async () => {
      const mock = mockFetchSuccess(TEMPLATE_LIST)

      await store.dispatch(evalApi.endpoints.listEvaluations.initiate({ projectId: PROJECT_ID }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates`)
      expect(calledUrl(mock)).not.toContain("limit=")
    })

    it("[tag:eval-api] provides only LIST tag when the query errors", async () => {
      mockFetchError(500)

      await store.dispatch(evalApi.endpoints.listEvaluations.initiate({ projectId: PROJECT_ID, limit: 10 }))

      const tags = store.getState().api.provided.tags
      expect(tags.EvalTemplate?.LIST).toBeDefined()
      expect(tags.EvalTemplate?.["evt-1"]).toBeUndefined()
    })

    it("[tag:eval-api] coerces a null body into an empty paginated result", async () => {
      mockFetchSuccess(null)

      const result = await store.dispatch(evalApi.endpoints.listEvaluations.initiate({ projectId: PROJECT_ID, limit: 10 }))

      expect(result.data?.data).toEqual([])
      expect(result.data?.pagination.total_count).toBe(0)
    })

    it("[tag:eval-api] preserves backend pagination metadata for template lists", async () => {
      mockFetchSuccess({
        data: TEMPLATE_LIST,
        pagination: { limit: 1, offset: 1, total_count: 42 },
      })

      const result = await store.dispatch(evalApi.endpoints.listEvaluations.initiate({ projectId: PROJECT_ID, limit: 1, offset: 1 }))

      expect(result.data?.data).toEqual(TEMPLATE_LIST)
      expect(result.data?.pagination).toEqual({ limit: 1, offset: 1, total_count: 42 })
    })
  })

  describe("getEvaluation", () => {
    it("[tag:eval-api] GETs a single template and provides its tag", async () => {
      const mock = mockFetchSuccess(TEMPLATE_DETAIL)

      await store.dispatch(evalApi.endpoints.getEvaluation.initiate({ projectId: PROJECT_ID, templateId: "evt-1" }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates/evt-1`)
      const tags = store.getState().api.provided.tags
      expect(tags.EvalTemplate?.["evt-1"]).toBeDefined()
    })
  })

  describe("createEvaluation", () => {
    it("[tag:eval-api] POSTs a new template", async () => {
      const mock = mockFetchSuccess(TEMPLATE_DETAIL)

      await store.dispatch(
        evalApi.endpoints.createEvaluation.initiate({
          projectId: PROJECT_ID,
          body: {
            evalName: "New",
            target: "agent_version",
            agent: { agentId: "a", agentVersion: "latest" },
            models: [],
            evaluationScope: "full_agent_execution",
            suite: "rag",
            evaluators: { strategy: "deterministic", deterministic: { metrics: ["correctness"] } },
            runMode: "single",
          },
        }),
      )

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates`)
      expect(calledMethod(mock)).toBe("POST")
    })
  })

  describe("updateEvaluation", () => {
    it("[tag:eval-api] PATCHes a template by id", async () => {
      const mock = mockFetchSuccess(TEMPLATE_DETAIL)

      await store.dispatch(
        evalApi.endpoints.updateEvaluation.initiate({ projectId: PROJECT_ID, templateId: "evt-1", body: { description: "x" } }),
      )

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates/evt-1`)
      expect(calledMethod(mock)).toBe("PATCH")
    })
  })

  describe("deleteEvaluation", () => {
    it("[tag:eval-api] DELETEs a template (soft)", async () => {
      const mock = mockFetchSuccess(null)

      await store.dispatch(evalApi.endpoints.deleteEvaluation.initiate({ projectId: PROJECT_ID, templateId: "evt-del" }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates/evt-del`)
      expect(calledUrl(mock)).not.toContain("hard=")
      expect(calledMethod(mock)).toBe("DELETE")
    })

    it("[tag:eval-api] DELETEs a template (hard) with the hard query param", async () => {
      const mock = mockFetchSuccess(null)

      await store.dispatch(
        evalApi.endpoints.deleteEvaluation.initiate({ projectId: PROJECT_ID, templateId: "evt-del", hard: true }),
      )

      expect(calledUrl(mock)).toContain("hard=true")
    })
  })

  // -- Test cases --

  describe("listTestCases", () => {
    it("[tag:eval-api] GETs cases for a template and provides the TestCase list tag", async () => {
      const mock = mockFetchSuccess([])

      await store.dispatch(evalApi.endpoints.listTestCases.initiate({ projectId: PROJECT_ID, templateId: "evt-1" }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates/evt-1/cases`)
      const tags = store.getState().api.provided.tags
      expect(tags.TestCase?.["LIST-evt-1"]).toBeDefined()
    })
  })

  describe("bulkAddTestCases", () => {
    it("[tag:eval-api] POSTs cases", async () => {
      const mock = mockFetchSuccess([])

      await store.dispatch(
        evalApi.endpoints.bulkAddTestCases.initiate({ projectId: PROJECT_ID, templateId: "evt-1", cases: [{}] }),
      )

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates/evt-1/cases`)
      expect(calledUrl(mock)).not.toContain("replace=")
      expect(calledMethod(mock)).toBe("POST")
    })

    it("[tag:eval-api] POSTs cases with replace=true", async () => {
      const mock = mockFetchSuccess([])

      await store.dispatch(
        evalApi.endpoints.bulkAddTestCases.initiate({ projectId: PROJECT_ID, templateId: "evt-1", cases: [{}], replace: true }),
      )

      expect(calledUrl(mock)).toContain("replace=true")
    })
  })

  describe("validateTestCases", () => {
    it("[tag:eval-api] POSTs to the validate endpoint", async () => {
      const mock = mockFetchSuccess({ errors: [], warnings: [] })

      await store.dispatch(
        evalApi.endpoints.validateTestCases.initiate({ projectId: PROJECT_ID, templateId: "evt-1", cases: [{}] }),
      )

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates/evt-1/cases/validate`)
      expect(calledMethod(mock)).toBe("POST")
    })
  })

  // -- Runs --

  describe("triggerRun", () => {
    it("[tag:eval-api] POSTs to trigger a run", async () => {
      const mock = mockFetchSuccess({ runId: "run-x", workflowId: "wf", status: "queued" })

      await store.dispatch(
        evalApi.endpoints.triggerRun.initiate({ projectId: PROJECT_ID, templateId: "evt-1", options: { actor: "me" } }),
      )

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/templates/evt-1/runs`)
      expect(calledMethod(mock)).toBe("POST")
    })
  })

  describe("listRuns", () => {
    it("[tag:eval-api] GETs runs and provides LIST + per-item tags", async () => {
      mockFetchSuccess(RUN_LIST)

      await store.dispatch(evalApi.endpoints.listRuns.initiate({ projectId: PROJECT_ID, templateId: "evt-1" }))

      const tags = store.getState().api.provided.tags
      expect(tags.EvalRun?.LIST).toBeDefined()
      expect(tags.EvalRun?.["run-1"]).toBeDefined()
      expect(tags.EvalRun?.["run-2"]).toBeDefined()
    })

    it("[tag:eval-api] GETs runs without optional params", async () => {
      const mock = mockFetchSuccess(RUN_LIST)

      await store.dispatch(evalApi.endpoints.listRuns.initiate({ projectId: PROJECT_ID }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/runs`)
    })

    it("[tag:eval-api] provides only LIST tag when runs query errors", async () => {
      mockFetchError(500)

      await store.dispatch(evalApi.endpoints.listRuns.initiate({ projectId: PROJECT_ID, templateId: "evt-1" }))

      const tags = store.getState().api.provided.tags
      expect(tags.EvalRun?.LIST).toBeDefined()
      expect(tags.EvalRun?.["run-1"]).toBeUndefined()
    })

    it("[tag:eval-api] preserves backend pagination metadata for run lists", async () => {
      mockFetchSuccess({
        data: RUN_LIST,
        pagination: { limit: 2, offset: 4, total_count: 17 },
      })

      const result = await store.dispatch(evalApi.endpoints.listRuns.initiate({ projectId: PROJECT_ID, templateId: "evt-1" }))

      expect(result.data?.data).toEqual(RUN_LIST)
      expect(result.data?.pagination).toEqual({ limit: 2, offset: 4, total_count: 17 })
    })
  })

  describe("getRun", () => {
    it("[tag:eval-api] GETs a single run and provides its tag", async () => {
      const mock = mockFetchSuccess(RUN_DETAIL)

      await store.dispatch(evalApi.endpoints.getRun.initiate({ projectId: PROJECT_ID, runId: "run-1" }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/runs/run-1`)
      const tags = store.getState().api.provided.tags
      expect(tags.EvalRun?.["run-1"]).toBeDefined()
    })
  })

  describe("cancelRun", () => {
    it("[tag:eval-api] POSTs to cancel a run", async () => {
      const mock = mockFetchSuccess(null)

      await store.dispatch(evalApi.endpoints.cancelRun.initiate({ projectId: PROJECT_ID, runId: "run-1" }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/runs/run-1/cancel`)
      expect(calledMethod(mock)).toBe("POST")
    })
  })

  describe("setBaseline", () => {
    it("[tag:eval-api] POSTs to set a run as baseline", async () => {
      const mock = mockFetchSuccess(RUN_DETAIL)

      await store.dispatch(evalApi.endpoints.setBaseline.initiate({ projectId: PROJECT_ID, runId: "run-1" }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/runs/run-1/baseline`)
      expect(calledMethod(mock)).toBe("POST")
    })
  })

  describe("listAuditEvents", () => {
    it("[tag:eval-api] GETs audit events for a run", async () => {
      const mock = mockFetchSuccess([])

      await store.dispatch(evalApi.endpoints.listAuditEvents.initiate({ projectId: PROJECT_ID, runId: "run-1" }))

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/evaluation/agents/runs/run-1/audit-events`)
    })
  })
})
