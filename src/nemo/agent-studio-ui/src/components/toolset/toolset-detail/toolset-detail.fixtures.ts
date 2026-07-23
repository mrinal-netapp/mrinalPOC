import type { ToolsetAgentRow, ToolsetDetailRecord } from "../toolset.types"

export const TOOLSET_DETAIL_FIXTURE: ToolsetDetailRecord = {
  id: "tool-mcp-01",
  name: "tool-mcp-01",
  status: "Healthy",
  type: "Custom",
  associatedAgents: "3",
  description: "Test toolset description",
  labels: "Staging, NFS",
  mcpServer: "https://mcp.example.com",
  authType: "Enterprise JWT",
  lastValidated: "1 hour ago",
  callsPerMinute: "60",
  callsPerDay: "1000",
  lastUpdated: "Feb 11, 2026",
  created: "Feb 10, 2026",
  connectionStatus: "connected",
  forwardedHeaders: "Authorization, X-Project-ID, X-User-ID, X-Session-ID",
  isPlatformManaged: false,
  metrics: {
    toolsCount: 6,
    successRate: "99.2%",
    calls: "4,896",
    avgLatencyMs: 245,
  },
}

export const TOOLSET_AGENTS_FIXTURE: ToolsetAgentRow[] = [
  { id: "a1", name: "agent-01", status: "Deployed", labels: ["Staging"], created: "Feb 10, 2026" },
]
