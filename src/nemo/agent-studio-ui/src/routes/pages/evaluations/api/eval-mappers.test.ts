import { describe, expect, it } from "vitest"

import {
  toCreateTemplateRequest,
  toUpdateDelta,
  fromTemplate,
  toBackendMetricIds,
  slugifyEvalName,
  casesSchemaVersionFor,
  canonicalCasesFilename,
  encodeEvalTargetKey,
  type EvalFormState,
} from "./eval-mappers"
import type { EvaluationTemplate } from "./eval.types"

const baseForm: EvalFormState = {
  name: "  My Eval  ",
  description: "  desc  ",
  selectedLabels: ["staging"],
  agentVersionKey: encodeEvalTargetKey("agent", "agt-1"),
  strategy: "both",
  judgeModel: "gpt-4o",
  judgeDimensionIds: ["helpfulness", "correctness"],
  deterministicMetricIds: ["rag_quality", "correctness"],
  testCaseSource: "upload",
  datasetColumnMapping: { id: "id", query: "q", expected: "e" },
  uploadedFileName: "cases.csv",
  scheduleEnabled: false,
}

describe("eval-mappers · toCreateTemplateRequest", () => {
  it("[tag:eval][tag:mappers] maps full form state into a create request", () => {
    const req = toCreateTemplateRequest(baseForm)

    expect(req.evalName).toBe("My Eval")
    expect(req.description).toBe("desc")
    expect(req.labels).toEqual(["staging"])
    expect(req.target).toBe("agent_version")
    expect(req.agent).toEqual({ agentId: "agt-1", agentVersion: "latest" })
    expect(req.models).toEqual(["gpt-4o"])
    expect(req.evaluationScope).toBe("full_agent_execution")
    expect(req.suite).toBe("rag")
    expect(req.runMode).toBe("single")
    expect(req.cases).toEqual({ source: "upload" })
  })

  it("[tag:eval][tag:mappers] includes cases.filename + schemaVersion when the form just uploaded a file", () => {
    const req = toCreateTemplateRequest({
      ...baseForm,
      casesFilename: "cases.csv",
      casesSchemaVersion: "flat_csv_legacy",
    })
    expect(req.cases).toEqual({
      source: "upload",
      filename: "cases.csv",
      schemaVersion: "flat_csv_legacy",
    })
    expect(req.evaluators.strategy).toBe("both")
    expect(req.evaluators.aiJudge).toEqual({
      models: ["gpt-4o"],
      dimensions: ["helpfulness", "correctness"],
    })
    expect(req.evaluators.deterministic).toEqual({
      metrics: ["rag_quality", "correctness"],
    })
  })

  it("[tag:eval][tag:mappers] parses agentVersionKey with a :: separator", () => {
    const req = toCreateTemplateRequest(
      { ...baseForm, agentVersionKey: encodeEvalTargetKey("agent", "agt-9::v2.4.1") },
    )

    expect(req.agent).toEqual({ agentId: "agt-9", agentVersion: "v2.4.1" })
  })

  it("[tag:eval][tag:mappers] omits a blank description", () => {
    const req = toCreateTemplateRequest({ ...baseForm, description: "   " })

    expect(req.description).toBeUndefined()
  })

  it("[tag:eval][tag:mappers] sends empty models when no judge model is set", () => {
    const req = toCreateTemplateRequest({ ...baseForm, judgeModel: "" })

    expect(req.models).toEqual([])
    expect(req.evaluators.aiJudge?.models).toEqual([])
  })

  it("[tag:eval][tag:mappers] llm_judge strategy omits the deterministic block", () => {
    const req = toCreateTemplateRequest({ ...baseForm, strategy: "llm_judge" })

    expect(req.evaluators.aiJudge).toBeDefined()
    expect(req.evaluators.deterministic).toBeUndefined()
  })

  it("[tag:eval][tag:mappers] deterministic strategy omits the aiJudge block", () => {
    const req = toCreateTemplateRequest({ ...baseForm, strategy: "deterministic" })

    expect(req.evaluators.aiJudge).toBeUndefined()
    expect(req.evaluators.deterministic).toBeDefined()
  })

  it("[tag:eval][tag:mappers] drops unknown/disabled metric ids without substituting a metric", () => {
    const req = toCreateTemplateRequest({
      ...baseForm,
      strategy: "deterministic",
      deterministicMetricIds: ["performance", "token_usage"],
    })

    // performance/token_usage are disabled for backend submission; do not run an unselected fallback.
    expect(req.evaluators.deterministic?.metrics).toEqual([])
  })

  it("[tag:eval][tag:mappers] exposes backend-enabled deterministic metrics for form validation", () => {
    expect(toBackendMetricIds(["performance", "token_usage"])).toEqual([])
    expect(toBackendMetricIds(["performance", "rag_quality"])).toEqual(["rag_quality"])
  })

  it("[tag:eval][tag:mappers] passes through enabled metric ids and maps rag_quality", () => {
    const req = toCreateTemplateRequest({
      ...baseForm,
      strategy: "deterministic",
      deterministicMetricIds: ["rag_quality", "tool_use", "safety"],
    })

    expect(req.evaluators.deterministic?.metrics).toEqual([
      "rag_quality",
      "tool_use",
      "safety",
    ])
  })

  it("[tag:eval][tag:mappers] maps a team target into a create request", () => {
    const req = toCreateTemplateRequest({
      ...baseForm,
      agentVersionKey: encodeEvalTargetKey("team", "team-1"),
    })

    expect(req.agent).toEqual({ agentTeam: "team-1" })
  })
})

describe("eval-mappers · toUpdateDelta", () => {
  const original: EvaluationTemplate = {
    templateId: "evt-1",
    projectId: "proj-1",
    evalName: "Orig",
    description: "old desc",
    labels: ["staging"],
    target: "agent_version",
    agent: { agentId: "agt-1", agentVersion: "latest" },
    models: ["gpt-4o"],
    evaluationScope: "full_agent_execution",
    suite: "rag",
    evaluators: {
      strategy: "both",
      aiJudge: { models: ["gpt-4o"], dimensions: ["helpfulness", "correctness"] },
      deterministic: { metrics: ["rag_quality", "correctness"] },
    },
    runMode: "single",
  }

  function formFrom(overrides: Partial<EvalFormState> = {}): EvalFormState {
    return {
      name: original.evalName,
      description: original.description ?? "",
      selectedLabels: original.labels ?? [],
      agentVersionKey: encodeEvalTargetKey("agent", original.agent.agentId ?? "agt-1"),
      strategy: "both",
      judgeModel: "gpt-4o",
      judgeDimensionIds: ["helpfulness", "correctness"],
      deterministicMetricIds: ["rag_quality", "correctness"],
      testCaseSource: "upload",
      datasetColumnMapping: { id: "", query: "" },
      uploadedFileName: "",
      scheduleEnabled: false,
      ...overrides,
    }
  }

  it("[tag:eval][tag:mappers] returns an empty delta when nothing changed", () => {
    const delta = toUpdateDelta(formFrom(), original)

    expect(delta).toEqual({})
  })

  it("[tag:eval][tag:mappers] detects a description change and clears to undefined when blanked", () => {
    expect(toUpdateDelta(formFrom({ description: "new desc" }), original).description).toBe("new desc")
    expect(toUpdateDelta(formFrom({ description: "  " }), original).description).toBeUndefined()
  })

  it("[tag:eval][tag:mappers] detects a labels change (order-insensitive)", () => {
    expect(toUpdateDelta(formFrom({ selectedLabels: ["staging"] }), original).labels).toBeUndefined()
    expect(toUpdateDelta(formFrom({ selectedLabels: ["prod"] }), original).labels).toEqual(["prod"])
  })

  it("[tag:eval][tag:mappers] detects an agent change", () => {
    const delta = toUpdateDelta(formFrom({ agentVersionKey: encodeEvalTargetKey("agent", "agt-2") }), original)

    expect(delta.agent).toEqual({ agentId: "agt-2", agentVersion: "latest" })
  })

  it("[tag:eval][tag:mappers] detects a team change", () => {
    const delta = toUpdateDelta(
      formFrom({ agentVersionKey: encodeEvalTargetKey("team", "team-2") }),
      original,
    )

    expect(delta.agent).toEqual({ agentTeam: "team-2" })
  })

  it("[tag:eval][tag:mappers] rebuilds evaluators when strategy changes", () => {
    const delta = toUpdateDelta(formFrom({ strategy: "deterministic" }), original)

    expect(delta.evaluators?.strategy).toBe("deterministic")
  })

  it("[tag:eval][tag:mappers] rebuilds evaluators when judge model changes", () => {
    const delta = toUpdateDelta(formFrom({ judgeModel: "claude" }), original)

    expect(delta.evaluators?.aiJudge?.models).toEqual(["claude"])
  })

  it("[tag:eval][tag:mappers] rebuilds evaluators when dimensions change", () => {
    const delta = toUpdateDelta(formFrom({ judgeDimensionIds: ["safety_harmlessness"] }), original)

    expect(delta.evaluators?.aiJudge?.dimensions).toEqual(["safety_harmlessness"])
  })

  it("[tag:eval][tag:mappers] rebuilds evaluators when metrics change", () => {
    const delta = toUpdateDelta(formFrom({ deterministicMetricIds: ["rag_quality"] }), original)

    expect(delta.evaluators?.deterministic?.metrics).toEqual(["rag_quality"])
  })

  it("[tag:eval][tag:mappers] adds cases block when the operator just uploaded a CSV", () => {
    const delta = toUpdateDelta(
      formFrom({
        testCaseSource: "upload",
        casesFilename: "cases.csv",
        casesSchemaVersion: "flat_csv_legacy",
      }),
      original,
    )

    expect(delta.cases).toEqual({
      source: "upload",
      filename: "cases.csv",
      schemaVersion: "flat_csv_legacy",
    })
  })

  it("[tag:eval][tag:mappers] skips the cases block when nothing changed about test cases", () => {
    const originalWithCases = { ...original, cases: { source: "upload" as const } }
    const delta = toUpdateDelta(formFrom({ testCaseSource: "upload" }), originalWithCases)

    expect(delta.cases).toBeUndefined()
  })

  it("[tag:eval][tag:mappers] diffs against a sparse original missing optional fields", () => {
    // No description, labels, aiJudge, or deterministic blocks on the original →
    // exercises every nullish-coalescing fallback in the delta comparison.
    const sparse = {
      templateId: "evt-9",
      projectId: "proj-1",
      evalName: "Bare",
      target: "agent_version",
      agent: { agentId: "agt-1", agentVersion: "latest" },
      models: [],
      evaluationScope: "full_agent_execution",
      suite: "rag",
      evaluators: { strategy: "both" },
      runMode: "single",
    } as unknown as EvaluationTemplate

    const delta = toUpdateDelta(
      formFrom({
        description: "added",
        selectedLabels: ["x"],
        judgeModel: "m",
        judgeDimensionIds: ["helpfulness"],
        deterministicMetricIds: ["rag_quality"],
      }),
      sparse,
    )

    expect(delta.description).toBe("added")
    expect(delta.labels).toEqual(["x"])
    expect(delta.evaluators).toBeDefined()
  })
})

describe("eval-mappers · slugifyEvalName / casesSchemaVersionFor", () => {
  it("[tag:eval][tag:mappers] lowercases, collapses non-alnum to dashes, trims edges", () => {
    expect(slugifyEvalName("Hello, Agent Test 2!")).toBe("hello-agent-test-2")
    expect(slugifyEvalName("  --foo--  ")).toBe("foo")
    expect(slugifyEvalName("---")).toBe("unnamed")
    expect(slugifyEvalName("")).toBe("unnamed")
  })

  it("[tag:eval][tag:mappers] picks the right schema version by extension", () => {
    expect(casesSchemaVersionFor("cases.csv")).toBe("flat_csv_legacy")
    expect(casesSchemaVersionFor("CASES.CSV")).toBe("flat_csv_legacy")
    expect(casesSchemaVersionFor("cases.jsonl")).toBe("golden_test_v1")
    expect(casesSchemaVersionFor("cases.json")).toBe("golden_test_v1")
  })

  it("[tag:eval][tag:mappers] canonicalises uploaded filenames by extension", () => {
    expect(canonicalCasesFilename("ag-lbgrm3qo-cases.csv")).toBe("cases.csv")
    expect(canonicalCasesFilename("My Cases (v2).CSV")).toBe("cases.csv")
    expect(canonicalCasesFilename("cases.jsonl")).toBe("cases.jsonl")
    expect(canonicalCasesFilename("rich-golden.json")).toBe("cases.jsonl")
    expect(canonicalCasesFilename("dataset")).toBe("cases.jsonl")
  })
})

describe("eval-mappers · fromTemplate", () => {
  it("[tag:eval][tag:mappers] maps a full template into form state", () => {
    const template: EvaluationTemplate = {
      templateId: "evt-1",
      projectId: "proj-1",
      evalName: "Finance Eval",
      description: "desc",
      labels: ["finance"],
      target: "agent_version",
      agent: { agentId: "agt-fin", agentVersion: "v1" },
      models: ["gpt-4o"],
      evaluationScope: "full_agent_execution",
      suite: "rag",
      evaluators: {
        strategy: "llm_judge",
        aiJudge: { models: ["judge-model"], dimensions: ["helpfulness"] },
        deterministic: { metrics: ["rag_quality"] },
      },
      cases: { source: "upload" },
      runMode: "single",
    }

    const form = fromTemplate(template)

    expect(form.name).toBe("Finance Eval")
    expect(form.description).toBe("desc")
    expect(form.selectedLabels).toEqual(["finance"])
    expect(form.agentVersionKey).toBe(encodeEvalTargetKey("agent", "agt-fin"))
    expect(form.strategy).toBe("llm_judge")
    expect(form.judgeModel).toBe("judge-model")
    expect(form.judgeDimensionIds).toEqual(["helpfulness"])
    expect(form.deterministicMetricIds).toEqual(["rag_quality"])
    expect(form.testCaseSource).toBe("upload")
    expect(form.scheduleEnabled).toBe(false)
  })

  it("[tag:eval][tag:mappers] applies defaults when evaluators/cases are missing", () => {
    const template = {
      templateId: "evt-2",
      projectId: "proj-1",
      evalName: "Bare",
      target: "agent_version",
      agent: { agentId: "agt-x", agentVersion: "" },
      models: ["fallback-model"],
      evaluationScope: "full_agent_execution",
      suite: "rag",
      evaluators: {},
      runMode: "single",
    } as unknown as EvaluationTemplate

    const form = fromTemplate(template)

    // strategy default 'both', all dimensions and metrics defaulted
    expect(form.strategy).toBe("both")
    expect(form.judgeDimensionIds?.length).toBeGreaterThan(0)
    expect(form.deterministicMetricIds).toEqual([
      "rag_quality",
      "correctness",
      "performance",
      "token_usage",
    ])
    // judgeModel falls back to template.models[0]
    expect(form.judgeModel).toBe("fallback-model")
    // testCaseSource defaults to upload in the eval create flow
    expect(form.testCaseSource).toBe("upload")
  })

  it("[tag:eval][tag:mappers] prefills a team target key", () => {
    const template = {
      templateId: "evt-team",
      projectId: "proj-1",
      evalName: "Team Eval",
      target: "agent_version",
      agent: { agentTeam: "team-1" },
      models: [],
      evaluationScope: "full_agent_execution",
      suite: "rag",
      evaluators: { strategy: "both" },
      runMode: "single",
    } as unknown as EvaluationTemplate

    expect(fromTemplate(template).agentVersionKey).toBe(encodeEvalTargetKey("team", "team-1"))
  })

  it("[tag:eval][tag:mappers] handles a missing agent ref and empty models", () => {
    const template = {
      templateId: "evt-3",
      projectId: "proj-1",
      evalName: "NoAgent",
      target: "agent_version",
      models: [],
      evaluationScope: "full_agent_execution",
      suite: "rag",
      evaluators: { strategy: "both" },
      runMode: "single",
    } as unknown as EvaluationTemplate

    const form = fromTemplate(template)

    expect(form.agentVersionKey).toBe("")
    expect(form.judgeModel).toBe("")
  })
})
