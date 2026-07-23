# Agent Chat UI Refactor — Architecture and Design

This document covers the architecture for the agent chat UI refactor: a generic streaming chat interface built on assistant-ui that serves all agent types, with targeted enhancements for analytics agents (SQL result rendering, Recharts charting). It also covers prompt mechanization via MCP server instructions and catalog prompt fragments.

## Overview

The agent chat UI provides a unified, streaming conversation interface for all agent types — general-purpose assistants, KB-backed agents, analytics agents, and any agent with MCP server tools attached. The core rendering pipeline (rich markdown, Mermaid diagrams, syntax highlighting, tool call visibility, citations) is agent-agnostic. Analytics-specific enhancements (SQL result tables, interactive charts) are layered on top via assistant-ui's Generative UI pattern and only activate when the relevant tools are invoked.

The system spans three independent plans:

| Plan | Scope | Status |
|------|-------|--------|
| Plan 1: Prompt Mechanization | Dynamic system prompt composition from MCP server instructions + catalog fragments | Implemented |
| Plan 2: Chat UI + Streaming | Generic assistant-ui chat UI with SSE streaming, tool call events, and analytics-specific Recharts visualization | Implemented |
| Plan 3: MCP Server Prompt Content | Catalog `promptFragment` content for each MCP server type | Implemented |

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Frontend (React 18)                       │
│                                                                  │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐  │
│  │ SessionSidebar│  │        AgentThread (assistant-ui)        │  │
│  │              │  │                                          │  │
│  │ • List       │  │  GENERIC (all agent types):              │  │
│  │ • Create     │  │  ┌────────────────────────────────────┐  │  │
│  │ • Rename     │  │  │  StreamdownTextPrimitive           │  │  │
│  │ • Delete     │  │  │  • Syntax highlighting (Shiki)     │  │  │
│  │              │  │  │  • Mermaid diagrams                │  │  │
│  │              │  │  │  • GFM tables                      │  │  │
│  │              │  │  ├────────────────────────────────────┤  │  │
│  │              │  │  │  CitationsSection (KB agents)      │  │  │
│  │              │  │  │  • Collapsible citations list      │  │  │
│  │              │  │  │  • KB name, score, source          │  │  │
│  │              │  │  ├────────────────────────────────────┤  │  │
│  │              │  │  │  Tool call status (all tools)      │  │  │
│  │              │  │  │  • Running / complete / error      │  │  │
│  │              │  │  │  • Copy / Retry action bar         │  │  │
│  │              │  │  │  • Model name + latency metadata   │  │  │
│  │              │  │  └────────────────────────────────────┘  │  │
│  │              │  │                                          │  │
│  │              │  │  ANALYTICS ENHANCEMENT (opt-in):         │  │
│  │              │  │  ┌────────────────────────────────────┐  │  │
│  │              │  │  │  SQLResultToolUI (Generative UI)   │  │  │
│  │              │  │  │  • Collapsible SQL display         │  │  │
│  │              │  │  │  • Data table with sticky headers  │  │  │
│  │              │  │  │  • Recharts (bar/line/pie)         │  │  │
│  │              │  │  │  • Only activates for execute_query│  │  │
│  │              │  │  └────────────────────────────────────┘  │  │
│  │              │  │                                          │  │
│  │              │  │  ┌────────────────────────────────────┐  │  │
│  │              │  │  │  Composer (send / cancel)          │  │  │
│  │              │  │  └────────────────────────────────────┘  │  │
│  └──────────────┘  └──────────────────────────────────────────┘  │
│                              │                                   │
│                    ChatModelAdapter (generic)                     │
│                    POST /invoke/stream                            │
│                    SSE parsing                                    │
└──────────────────────┬───────────────────────────────────────────┘
                       │ SSE stream (generic protocol)
┌──────────────────────▼───────────────────────────────────────────┐
│                    Agent Service (FastAPI)                        │
│                                                                  │
│  event_generator() — works with ALL agent types                  │
│  ├─ agent.arun(stream=True, stream_intermediate_steps=True)      │
│  ├─ ToolCallStarted → SSE event: tool_call_start                │
│  ├─ ToolCallCompleted → SSE event: tool_call_result             │
│  ├─ RunResponseContent → SSE event: message                      │
│  └─ done → SSE event: done {sessionId, latencyMs, citations}    │
│                                                                  │
│  System Prompt = MCP fragments + KB context + user prompt        │
│  ├─ serverInstructions (from MCP InitializeResult)               │
│  └─ promptFragment (from catalog, with {projectId} interpolation)│
└──────────────────────────────────────────────────────────────────┘
```

---

## Plan 1: Prompt Mechanization

### Problem

System prompt composition was hardcoded — the DuckDB Iceberg visualization instructions were conditionally injected by checking `catalogId == "duckdb_iceberg"`. This approach:
- Doesn't scale to new MCP servers
- Couples server-specific prompt content to agent factory logic
- Makes adding visualization guidance for new servers require code changes

### Solution

A generic, data-driven prompt composition pipeline that collects fragments from two sources:

1. **Server Instructions** (`MCPServer.serverInstructions`): Dynamic instructions returned by the MCP server during the `initialize` handshake (`InitializeResult.instructions` per the MCP protocol). Captured at connection time and persisted on the entity.

2. **Catalog Prompt Fragments** (`MCPServerCatalogEntry.promptFragment`): Static, platform-defined text configured in the catalog entry. Supports `{projectId}` placeholder interpolation.

### Data Flow

```
MCP Server → initialize → InitializeResult.instructions
    ↓
BifrostGatewayClient.initMcpSession() → extracts instructions
    ↓
testMCPConnection() → returns serverInstructions
    ↓
MCPServer entity → persists serverInstructions column
    ↓
agentRoutes.ts → includes in _resolvedMCPServers
    ↓
agent_factory.py → _collect_mcp_prompt_fragments()
    ↓
Final system prompt = MCP fragments + KB context + user-defined prompt
```

### Key Components

**`_collect_mcp_prompt_fragments()`** (`agent_factory.py`): Iterates resolved MCP servers, collects `serverInstructions` and `promptFragment`, interpolates `{projectId}`, enforces `MCP_PROMPT_MAX_CHARS` (default 4000) safety limit.

**`MCPServer` entity** (`MCPServer.ts`): Added nullable `serverInstructions` text column via migration `addServerInstructionsColumn`.

**`BifrostGatewayClient.initMcpSession()`** ([`BifrostGatewayClient.ts`](../../src/nemo/config-service/services/BifrostGatewayClient.ts)): Parses `InitializeResult.instructions` from the MCP initialize response. (The pre-migration class name was `LiteLLMClient`; renamed wholesale to `BifrostGatewayClient` when the gateway moved — see [bifrost-migration.md](../design/bifrost-migration.md).)

---

## Plan 2: Chat UI + Streaming (Generic Agent Chat Refactor)

This plan replaces the polling-based chat UI with a real-time streaming interface built on assistant-ui. The refactored UI is **agent-agnostic by design** — it works identically for general-purpose assistants, KB-backed Q&A agents, Kubernetes management agents, and analytics agents. Analytics-specific rendering (SQL result tables, Recharts charting) is layered on top via the Generative UI pattern and only activates when the matching tool (`execute_query`) appears in the stream. Non-analytics agents are entirely unaffected by its presence.

### Runtime Architecture

**Choice: `useLocalRuntime` + `ChatModelAdapter` (NOT `useDataStreamRuntime`)**

The agent-service expects `{ message: string, sessionId: string | null }` — a single user message, not a full conversation history. `useDataStreamRuntime` sends `{ messages[], tools, system }` which is incompatible. `useLocalRuntime` with a `ChatModelAdapter` lets us:

- Extract the last user message from assistant-ui's message array
- POST it to `/invoke/stream` with our custom request schema
- Parse the SSE response and yield text + tool-call parts back to assistant-ui
- Maintain full control over the request/response mapping

### SSE Event Protocol

The streaming endpoint (`/invoke/stream`) emits these event types:

| Event | Payload | Description |
|-------|---------|-------------|
| `message` | `string` (text chunk) | Incremental text content from the LLM |
| `tool_call_start` | `{ toolCallId, toolName, args }` | Tool invocation started (Agno `ToolCallStartedEvent`) |
| `tool_call_result` | `{ toolCallId, result }` | Tool invocation completed (Agno `ToolCallCompletedEvent`) |
| `done` | `{ sessionId, latencyMs, modelName, citations }` | Stream complete with metadata |
| `error` | `string` | Error message |

The backend passes `stream_intermediate_steps=True` to `agent.arun()` to receive `ToolCallStarted` and `ToolCallCompleted` events from the Agno framework. The `ToolExecution` object provides `tool_call_id`, `tool_name`, and `tool_args`.

### Frontend Components

#### Generic (all agent types)

**`useAgentRuntime` hook** (`hooks/useAgentRuntime.ts`):
- Creates a `ChatModelAdapter` that POSTs to `/invoke/stream`
- Parses SSE events via a lightweight async generator (`parseSSE`)
- Yields `ChatModelRunResult` with text + tool-call content parts
- Fires `onStreamDone` callback with session/citation metadata
- Supports initial message loading via `ThreadHistoryAdapter`
- Completely agent-agnostic — works with any agent type

**`AgentThread`** (`components/chat/AgentThread.tsx`):
- Wraps `AssistantRuntimeProvider` with `ThreadPrimitive` components
- Uses `StreamdownTextPrimitive` with `@streamdown/code` (syntax highlighting) and `@streamdown/mermaid` (diagram rendering) — renders any markdown the LLM generates
- Custom `AssistantMessage` with copy/retry action bar, metadata display (model name, latency), and citations section (for KB-backed agents)
- Custom `Composer` with FluentUI-styled send/cancel buttons
- Tool call lifecycle visibility (running/complete states) for all tool types

**`AgentChat`** (`pages/AgentChat.tsx`):
- Orchestrates agent loading, session management, and thread lifecycle
- `SessionSidebar` is preserved unchanged
- Uses key-based remounting (`key={sessionId-threadKey}`) for session switching
- Delegates to `ThreadContainer` which creates the runtime and renders `AgentThread`

#### Analytics enhancement (opt-in, zero impact on other agents)

**`SQLResultToolUI`** (`components/chat/SQLResultToolUI.tsx`):
- Generative UI registered via `makeAssistantToolUI` for the `execute_query` tool name
- **Only activates when `execute_query` appears in the stream** — agents that never call this tool see no effect
- Three states: running (spinner), incomplete (error), complete (results)
- Collapsible SQL query display
- Auto-detects chartable data (identifies label + numeric columns)
- Table/Chart toggle with Bar, Line, and Pie chart options via Recharts
- Supports both columnar (`columns[]` + `rows[][]`) and dict-based (`data[]`) result formats

#### Extensibility

The Generative UI pattern scales to new tool types. To add custom rendering for any new tool (e.g., `list_tables`, `kubectl_get`, `search_documents`), create a new `makeAssistantToolUI` component with the matching `toolName` and register it inside `AgentThread`. No changes to the runtime, adapter, or backend are needed.

### Session History

Session persistence is handled server-side in the stream handler's `finally` block (unchanged). For loading historical sessions:

1. `SessionSidebar` triggers `handleSelectSession(sessionId)`
2. `AgentChat` fetches messages via `agentInvokeApi.getSession()`
3. Messages are converted to `SessionMessage[]` and passed to `ThreadContainer`
4. `ThreadContainer` remounts (via key change), creating a new runtime
5. The `ThreadHistoryAdapter.load()` returns the pre-fetched messages
6. assistant-ui hydrates the thread with historical messages

### React 18 Compatibility

The project uses React 18.2.0 with FluentUI v9. assistant-ui v0.12.x works with React 18 — the known `forwardRef` issues primarily affect shadcn/ui button components (not FluentUI buttons). Since we use FluentUI's own `Button` component (not shadcn), no `forwardRef` patches are needed.

### Dependencies Added

| Package | Purpose | Scope |
|---------|---------|-------|
| `@assistant-ui/react` | Core chat runtime and primitives | Generic |
| `@assistant-ui/react-streamdown` | Markdown rendering with streaming support | Generic |
| `@streamdown/code` | Syntax highlighting plugin | Generic |
| `@streamdown/mermaid` | Mermaid diagram rendering plugin | Generic |
| `eventsource-parser` | SSE text parsing utility | Generic |
| `recharts` | Chart rendering (Bar, Line, Pie) | Analytics |

---

## Plan 3: MCP Server Prompt Content

### Catalog Prompt Fragments

Each MCP server type in the catalog defines a `promptFragment` that tells the LLM how to use that server's tools effectively and how to present results:

| Server | Key Prompt Guidance |
|--------|-------------------|
| **duckdb_iceberg** | Iceberg catalog path pattern (`iceberg.{projectId}.<table>`), always call `list_tables()` first, fully-qualified table names, Mermaid chart suggestions for different data shapes |
| **postgres_mcp** | Inspect schema before querying, parameterized queries, markdown tables |
| **kubernetes_mcp** | Markdown tables for listings, Mermaid flowcharts for resource relationships |
| **filesystem_mcp** | Directory listings as markdown tables |
| **github_mcp** | Issues/PRs as markdown tables with key columns |
| **sqlite_mcp** | Inspect schema first, markdown tables |
| **memory_mcp** | Knowledge graph for structured facts, Mermaid flowcharts for entity relationships |

### Visualization Guidance Strategy

Prompt fragments guide the LLM to produce output that the frontend can render richly:

- **Markdown tables**: Rendered natively by `StreamdownTextPrimitive` with GFM support
- **Mermaid diagrams**: `pie`, `xychart-beta`, `flowchart` — rendered by `@streamdown/mermaid`
- **Structured tool results**: `execute_query` results rendered by `SQLResultToolUI` with table + chart views
- **Code blocks**: Syntax-highlighted by `@streamdown/code`

The prompts don't request specific frontend components — they suggest standard markdown/Mermaid syntax that the LLM can generate, and the frontend rendering pipeline handles the rest.

---

## Security Considerations

- **Prompt size limit**: `MCP_PROMPT_MAX_CHARS` (env var, default 4000) prevents runaway prompt injection from MCP servers
- **Auth token forwarding**: `ChatModelAdapter` reads the JWT from `getAuthToken()` and forwards it via `Authorization` header
- **SSE error handling**: Backend yields `error` events on exceptions; frontend surfaces them as thrown errors in the adapter
- **Session isolation**: Sessions are scoped by `agent_id + user_id`; the backend validates project access

## What Every Agent Gets (Generic Benefits)

The chat UI refactor benefits all agent types equally:

- **Real-time streaming** — replaces the old polling + typewriter animation with true SSE streaming
- **Rich markdown rendering** — syntax-highlighted code blocks, GFM tables, Mermaid diagrams
- **Tool call visibility** — users see "tool running" / "tool complete" states for any tool, not just SQL
- **Copy / Retry actions** — on every assistant message
- **Citations** — collapsible citation list with KB name, relevance score, and source for KB-backed agents
- **Metadata display** — model name and response latency on every assistant message
- **Session management** — unchanged sidebar with create, rename, delete, and history loading

## Known Limitations

1. **AgentPlayground** (`AgentPlayground.tsx`) has its own inline `ReactMarkdown` rendering and is NOT migrated. It continues using the old rendering path.
2. **Upstream MCP servers** (Postgres, SQLite, Filesystem, GitHub, Memory, Kubernetes) do not natively return `instructions` in their `InitializeResult`. The `serverInstructions` field will be `null` for these — only catalog `promptFragment` content applies.
3. **Chart auto-detection** is heuristic: it identifies numeric vs string columns and suggests chart types. Complex multi-dimensional data may not chart well automatically.
4. **No `@assistant-ui/react-data-stream`**: We deliberately do not use the data-stream package since `useLocalRuntime` handles our custom SSE format directly.
5. **SQLResultToolUI is always registered** but is inert for non-analytics agents — it only activates when `execute_query` tool calls appear in the stream. A future refinement could make tool UI registration configurable per agent type.
