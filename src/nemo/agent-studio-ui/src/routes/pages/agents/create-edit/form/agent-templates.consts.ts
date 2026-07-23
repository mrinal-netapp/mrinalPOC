export interface AgentTemplateExample {
  title: string;
  scenario: string;
  response: string;
}

export type AgentTemplateOrchestrationPattern =
  | "Sequential"
  | "Coordinate"
  | "Route"
  | "Collaborate";

export interface AgentTemplateResourceRequirement {
  id: string;
  label: string;
  description: string;
  required: boolean;
}

export interface AgentTemplateAgentRequirements {
  knowledgeBases: AgentTemplateResourceRequirement[];
  mcpServers: AgentTemplateResourceRequirement[];
}

export interface AgentTemplateAgentDefinition {
  name: string;
  role: string;
  systemPrompt: string;
  modelId: string;
  requirements: AgentTemplateAgentRequirements;
}

export interface AgentTemplateDefinition {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  examples: AgentTemplateExample[];
  instructions: string;
  orchestrationPattern: AgentTemplateOrchestrationPattern;
  /** Recommended model display name or identifier for the template. */
  model: string;
  /** Manager agent role, maps to the team `manager.role` on save. */
  role: string;
  agents: AgentTemplateAgentDefinition[];
  /**
   * When true, the template is kept in the catalog but hidden from the
   * selection picker. Reserved for a later rollout phase.
   */
  hidden?: boolean;
}

const TEMPLATE_DETAILS_FALLBACK = "No content available for this template.";

/** Formats catalog examples for the template details side pane. */
export function formatTemplateExamples(examples: AgentTemplateExample[]): string {
  if (examples.length === 0) {
    return TEMPLATE_DETAILS_FALLBACK;
  }

  return examples
    .map((example, index) =>
      [
        `Example ${index + 1}:`,
        example.title,
        "Scenario:",
        example.scenario,
        "Response:",
        example.response,
      ].join("\n"),
    )
    .join("\n\n");
}

export function formatTemplateInstructions(instructions: string): string {
  return instructions.trim() || TEMPLATE_DETAILS_FALLBACK;
}

/**
 * Static agent-template catalog. config-service exposes no agent-template
 * endpoint yet (only the unrelated `/workspace-templates`); replace this
 * with an API-backed loader when one exists.
 */
export const AGENT_TEMPLATE_CATALOG: AgentTemplateDefinition[] = [
  {
    id: "tmpl-predictive-capacity",
    name: "Predictive capacity and performance agent",
    description: "Continually monitors storage health and forecasts exhaustion risks.",
    capabilities: ["Knowledge bases", "Toolsets"],
    examples: [
      {
        title: "Daily Health Summary",
        scenario: "Automated morning report generation",
        response:
          "Agent generates daily summary: infrastructure Health Score 84/100 | 2% from yesterday), 12 volumes monitored across 3 regions. Capacity trending healthy, 87 days until first exhaustion, 2 minor performance alerts (low environment), bot auto-music. No incidents in past 24 hours. 3 optimization recommendations identified by Cost Agent.",
      },
      {
        title: "Performance Degradation RCA",
        scenario: "Sudden latency spike investigation",
        response:
          "Agent analyzes incident timeline: 14:23 UTC - Latency spike from 2ms to 46ms on prod-db-01 volume. Correlates events: 14:20 UTC - Network switch firmware update in same subnet, 14:22 UTC - TCP retransmission rate increased 300%. ROOT CAUSE: Network switch update caused brief routing instability. Impact: 12 minutes elevated latency, no data loss. RECOMMENDATION: Schedule network changes during maintenance windows, implement pre/post validation checks.",
      },
      {
        title: "Cross-Region Anomaly Detection",
        scenario: "Unusual pattern across multiple systems",
        response:
          "Agent detects anomaly: IOPS decreased 40% across all volumes in US-EAST region between 22:00-23:00 UTC, while CPU utilization remained normal. Correlation: intensive scheduled backup job consumed network bandwidth impacting storage I/O. Not a failure, but suboptimal scheduling. RECOMMENDATION: Reschedule backup window to avoid peak business hours, or allocate dedicated backup network.",
      },
    ],
    instructions:
      "You are the storage capacity program manager. Coordinate the capacity analyst's forecasts into a single, decision-ready report: state current utilization, days-to-exhaustion per volume/region, and the top 3 risks ranked by urgency. Every recommendation must cite the specific metric or log evidence it is based on; never speculate without data. Escalate immediately (do not wait for the next scheduled report) if any volume is projected to exhaust capacity within 14 days. If the analyst reports a required knowledge base or tool is unavailable, state which finding is degraded and why before presenting the rest of the report.",
    orchestrationPattern: "Sequential",
    model: "Claude Sonnet 4",
    role: "Storage capacity program manager",
    agents: [
      {
      name: "Predictive capacity and performance agent",
      role: "Storage capacity analyst",
      systemPrompt:
        "You are a storage capacity analyst. Continuously monitor volume utilization, IOPS, and latency; forecast capacity exhaustion dates per volume and region using historical growth trends; and detect anomalies (unexpected drops or spikes) before they cause an incident. For every finding, report: current value, trend direction, forecasted date of concern (if any), and confidence level. When correlating an anomaly to a probable cause, cross-reference recent events in the telemetry runbooks knowledge base before naming a root cause. Never state a forecast or root cause without citing the underlying metric or runbook evidence. If the storage metrics API is unavailable, explicitly say forecasting cannot be performed and fall back to the last known snapshot rather than guessing.",
      modelId: "model-claude-sonnet-4",
      requirements: {
        knowledgeBases: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            label: "Storage telemetry runbooks",
            description:
              "Purpose: gives the agent the capacity alert thresholds, established remediation playbooks, and per-region baseline norms it needs to judge whether a metric reading is actually abnormal (rather than normal regional variance) and what the standard response is. Impact if missing: the agent can still read raw metrics but cannot tell a real capacity risk from normal fluctuation, so it will either miss early warnings or over-alert, and its remediation suggestions will be generic instead of matched to your organization's playbooks.",
            required: true,
          },
        ],
        mcpServers: [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            label: "Storage metrics API",
            description:
              "Purpose: the agent's only source of live volume utilization, IOPS, and latency data; without it there is nothing to forecast or monitor. Impact if missing: the agent cannot observe current storage health at all; it cannot produce forecasts, detect anomalies, or generate the daily health summary, and will only be able to reason from whatever the user pastes into the conversation.",
            required: true,
          },
        ],
      },
    },
    ],
  },
  {
    id: "tmpl-storage-optimization",
    name: "Storage optimization and cost governance",
    description: "Identifies under-utilized volumes and surfaces cost-saving actions.",
    capabilities: ["Knowledge bases", "Toolsets"],
    examples: [
      {
        title: "Right-sizing recommendation",
        scenario: "Monthly cost review for overprovisioned volumes",
        response:
          "Detect idle or overprovisioned storage assets, propose right-sizing actions, and quantify expected monthly savings.",
      },
    ],
    instructions:
      "You are the cost governance manager for storage optimization. Route the planner's right-sizing proposals to the performance validator before any action reaches the final report: no recommendation is presented to the user unless it has passed a performance-risk check. Prioritize low-risk opportunities first. Every recommendation in the final output must include: the proposed action, the risk-adjusted savings estimate, the validator's performance verdict, and a confidence band. If any of the three member agents could not complete its analysis because a required knowledge base or toolset was missing, state that explicitly in the report instead of silently omitting the affected recommendations.",
    orchestrationPattern: "Coordinate",
    model: "GPT-4.1",
    role: "Cost governance manager",
    agents: [
      {
        name: "Storage optimization planner",
        role: "Right-sizing strategist",
        systemPrompt:
          "You are a right-sizing strategist for storage. Identify under-utilized volumes (sustained low IOPS/throughput relative to provisioned capacity), propose specific right-sizing actions (e.g. downsize tier, shrink capacity pool, consolidate volumes), and rank each opportunity by risk-adjusted savings. For every proposal, state: the current provisioned vs. actual usage, the proposed change, the estimated monthly savings, and the sizing/cost guidance from the optimization knowledge base that justifies it. Do not propose an action for a volume whose recent logs show active incidents or anomalies; flag those for investigation instead. Hand off every proposal to the performance validator before it is considered final; never present an unvalidated proposal as a recommendation.",
        modelId: "model-gpt-4-1",
        requirements: {
          knowledgeBases: [
            {
              id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              label: "Storage optimization knowledge base",
              description:
                "Purpose: gives the agent the storage platform's own sizing, performance, and cost guidance so its right-sizing proposals follow supported configurations instead of generic assumptions. Impact if missing: the agent can still spot low utilization from raw metrics, but its right-sizing proposals will not be grounded in vendor-supported sizing guidance, increasing the risk of recommending an unsupported or performance-degrading configuration change.",
              required: true,
            },
          ],
          mcpServers: [
            {
              id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              label: "Storage logs MCP",
              description:
                "Purpose: lets the agent check whether a candidate volume has recent incidents or anomalies before proposing to resize it, so it doesn't recommend touching a volume that is mid-incident. Impact if missing: the agent will rank and propose right-sizing actions using metrics alone, risking a recommendation on a volume with an active, log-visible issue that the metrics don't yet reflect.",
              required: true,
            },
            {
              id: "ffffffff-eeee-4fff-8fff-ffffffffffff",
              label: "Storage metrics connector",
              description:
                "Purpose: the primary data source for identifying under-utilization; utilization, latency, IOPS, throughput, and capacity readings are what the agent compares against provisioned capacity to find right-sizing candidates. Impact if missing: the agent has no utilization data to work from, so it cannot identify under-utilized volumes or produce any right-sizing proposal at all.",
              required: true,
            },
          ],
        },
      },
      {
        name: "Storage performance validator",
        role: "Performance risk analyst",
        systemPrompt:
          "You are a performance risk analyst. Your job is to catch any optimization proposal from the planner that could degrade storage workload performance before it reaches a user. For each proposed action, check current IOPS, latency, and throughput trends (including burst behavior) against the workload's documented criticality and SLO guardrails, and cross-check logs for any regression correlated with similar past changes. Return one of three verdicts per proposal: Approved, Approved with caveats (state the caveat and monitoring needed), or Rejected (state the specific guardrail it would violate and, where possible, a safer alternative sizing). Never approve a proposal for a workload tagged business-critical without explicit SLO headroom evidence.",
        modelId: "model-claude-sonnet-4",
        requirements: {
          knowledgeBases: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              label: "Storage performance and SLO runbooks",
              description:
                "Purpose: defines the latency/IOPS guardrails and workload-criticality tiers the agent must check a proposal against; without a defined guardrail there is nothing objective to validate against. Impact if missing: the agent can still compare relative metric trends, but has no defined SLO thresholds or criticality tiers to judge against, so its Approved/Rejected verdicts become subjective judgment calls instead of policy-backed decisions.",
              required: true,
            },
          ],
          mcpServers: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              label: "Storage metrics connector",
              description:
                "Purpose: supplies the IOPS, latency, throughput, and burst-behavior trend windows the agent checks each proposal against to decide if it's safe. Impact if missing: the agent cannot verify a proposal's performance impact from data at all, and every verdict would have to be a guess rather than an evidence-based approval or rejection.",
              required: true,
            },
            {
              id: "bbbbbbbb-aaaa-4bbb-8bbb-bbbbbbbbbbbb",
              label: "Storage logs MCP",
              description:
                "Purpose: lets the agent correlate a proposed change with past log events (e.g. prior resizes that caused regressions) for root-cause-aware, not just metric-based, risk judgments. Impact if missing: the agent loses the ability to catch performance risks that are only visible in logs (e.g. a similar past change that caused an incident), so its validation relies on metrics alone and may approve a proposal with a known log-documented failure pattern.",
              required: true,
            },
          ],
        },
      },
      {
        name: "Storage savings reporter",
        role: "FinOps reporting specialist",
        systemPrompt:
          "You are a FinOps reporting specialist. Convert approved (or approved-with-caveats) optimization actions into an executive-ready savings report: state the total projected monthly/annual savings, the assumptions behind each estimate, a confidence band (high/medium/low, with the reason), and a realistic implementation timeline with milestones. Clearly separate actions that are fully approved from those with performance caveats, and never report a savings number for an action the validator rejected. When actual realized savings diverge from the original forecast, explain the variance using operational context rather than only restating the numbers.",
        modelId: "model-gpt-4-1-mini",
        requirements: {
          knowledgeBases: [
            {
              id: "bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb",
              label: "Storage FinOps and chargeback guide",
              description:
                "Purpose: gives the agent the organization's cost allocation rules, budgeting conventions, and reporting format so savings figures land in the categories finance actually uses. Impact if missing: the agent can still sum raw savings from metrics, but the report will use generic cost categories instead of your chargeback model, making it harder for finance stakeholders to reconcile the numbers against their own budgets.",
              required: true,
            },
          ],
          mcpServers: [
            {
              id: "cccccccc-1111-4ccc-8ccc-cccccccccccc",
              label: "Storage metrics connector",
              description:
                "Purpose: supplies the historical utilization and growth trend data the agent uses to project future spend and quantify realized savings after an action is implemented. Impact if missing: the agent cannot calculate or verify savings figures from real usage data, so the report would rely entirely on the planner's original estimates with no ability to confirm actual realized savings.",
              required: true,
            },
            {
              id: "dddddddd-1111-4ddd-8ddd-dddddddddddd",
              label: "Storage logs MCP (optional)",
              description:
                "Purpose: gives the agent operational context (e.g. a delayed rollout or an incident) to explain why realized savings diverged from the forecast, instead of just reporting a gap. Impact if missing: this is optional; the agent still reports accurate savings totals, but when actual results differ from the forecast it can only show the numeric variance, not the operational reason behind it.",
              required: false,
            },
          ],
        },
      },
    ],
  },
  {
    id: "tmpl-compliance-security",
    name: "Compliance and security enforcement",
    description: "Validates security baselines and flags compliance drift.",
    capabilities: ["Knowledge bases", "Toolsets"],
    hidden: true,
    examples: [
      {
        title: "Policy violation triage",
        scenario: "Weekly compliance scan across production assets",
        response:
          "Surface policy violations, identify affected assets, and suggest immediate remediation and longer-term controls.",
      },
    ],
    instructions:
      "Evaluate controls against approved baselines and report drift with severity, blast radius, and remediation steps.",
    orchestrationPattern: "Route",
    model: "Claude Sonnet 4",
    role: "Compliance and security manager",
    agents: [
      {
      name: "Compliance and security enforcement agent",
      role: "Security compliance auditor",
      systemPrompt:
        "You validate security baselines, flag compliance drift, and recommend remediation with severity scoring.",
      modelId: "model-claude-sonnet-4",
      requirements: {
        knowledgeBases: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            label: "Security baseline catalog",
            description: "Approved controls, CIS benchmarks, and policy mappings",
            required: true,
          },
        ],
        mcpServers: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            label: "Policy scanner",
            description: "Run compliance checks against connected storage endpoints",
            required: true,
          },
        ],
      },
    },
    ],
  },
  {
    id: "tmpl-observability-reporting",
    name: "Observability, reporting, and RCA Agent",
    description: "Aggregates performance, health, and reliability signals into actionable insights.",
    capabilities: ["Knowledge bases", "Toolsets"],
    hidden: true,
    examples: [
      {
        title: "Incident summary",
        scenario: "Post-incident review for a production outage",
        response:
          "Build incident summaries with timeline reconstruction and root-cause candidates based on correlated telemetry.",
      },
    ],
    instructions:
      "Generate concise, executive-friendly reports while preserving technical evidence for engineering follow-up.",
    orchestrationPattern: "Collaborate",
    model: "GPT-4.1",
    role: "Observability and reliability manager",
    agents: [
      {
      name: "Observability, reporting, and RCA agent",
      role: "Site reliability analyst",
      systemPrompt:
        "You aggregate telemetry into actionable incident summaries with timeline reconstruction and root-cause candidates.",
      modelId: "model-gpt-4-1",
      requirements: {
        knowledgeBases: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            label: "Incident response playbooks",
            description: "RCA templates, escalation paths, and reporting standards",
            required: true,
          },
        ],
        mcpServers: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            label: "Observability query API",
            description: "Correlate logs, metrics, and traces across services",
            required: true,
          },
        ],
      },
    },
    ],
  },
  {
    id: "tmpl-anomaly-detection",
    name: "Anomaly detection agent",
    description: "Detects unusual IOPS and throughput behavior before user impact escalates.",
    capabilities: ["Knowledge bases", "Toolsets"],
    hidden: true,
    examples: [
      {
        title: "Baseline deviation alert",
        scenario: "Real-time monitoring of IOPS across critical volumes",
        response:
          "Compare live metrics against seasonality baselines and flag significant deviations with confidence scores.",
      },
    ],
    instructions:
      "Treat one-off spikes as informational unless persistence or multi-signal correlation indicates real risk.",
    orchestrationPattern: "Sequential",
    model: "Claude Haiku 4",
    role: "Anomaly detection manager",
    agents: [
      {
      name: "Anomaly detection agent",
      role: "Performance anomaly detector",
      systemPrompt:
        "You compare live storage metrics against seasonality baselines and flag deviations with confidence scores.",
      modelId: "model-claude-haiku-4",
      requirements: {
        knowledgeBases: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            label: "Seasonality baselines",
            description: "Historical IOPS and throughput patterns by workload class",
            required: true,
          },
        ],
        mcpServers: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            label: "Metrics stream API",
            description: "Subscribe to real-time volume performance signals",
            required: false,
          },
        ],
      },
    },
    ],
  },
  {
    id: "tmpl-data-protection",
    name: "Data protection agent",
    description: "Monitors snapshot schedules and backup posture to reduce data-loss exposure.",
    capabilities: ["Knowledge bases", "Toolsets"],
    hidden: true,
    examples: [
      {
        title: "Backup posture review",
        scenario: "Daily validation of snapshot and backup coverage",
        response:
          "Highlight backup gaps, stale snapshots, and unmet RPO/RTO objectives across critical workloads.",
      },
    ],
    instructions:
      "Escalate protection issues by business criticality and suggest practical remediation windows.",
    orchestrationPattern: "Route",
    model: "GPT-4.1 mini",
    role: "Data protection manager",
    agents: [
      {
      name: "Data protection agent",
      role: "Backup and recovery specialist",
      systemPrompt:
        "You monitor snapshot schedules and backup posture, highlighting gaps against RPO/RTO objectives.",
      modelId: "model-gpt-4-1-mini",
      requirements: {
        knowledgeBases: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            label: "Data protection standards",
            description: "RPO/RTO targets, retention policies, and criticality tiers",
            required: true,
          },
        ],
        mcpServers: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            label: "Snapshot manager API",
            description: "Inspect snapshot schedules, staleness, and coverage gaps",
            required: true,
          },
        ],
      },
    },
    ],
  },
];
