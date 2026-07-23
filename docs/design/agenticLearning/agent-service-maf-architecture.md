# agent-service-maf Architecture

> End-to-end walkthrough of the Multi-Agent Framework (MAF) service —
> how a user request flows through the gateway, guardrails, framework
> adapters, MCP tool layer, and back — including all config-service
> interactions.

---

## 1. Layered Architecture

```mermaid
flowchart TD
    U([User / Browser / Agent-Team])

    subgraph IF["Interface Layer"]
        REST["REST — POST /chat"]
        SSE["SSE — streaming tokens"]
        WS["WebSocket — bidirectional"]
        AUTH["auth.py — JWT / SA token"]
    end

    subgraph GR["Guardrails Layer"]
        IG["Input: input_validator → prompt_injection → pii_masker"]
        OG["Output: content_filter → pii_masker → output_length"]
        TG["Tool: max_calls_per_request, denylist"]
    end

    subgraph FW["Framework / Executor Layer"]
        EXEC["executor.py → registry.py"]
        SK["SemanticKernel adapter"]
        CR["CrewAI adapter"]
        LG["LangGraph adapter"]
        ORCH["Orchestration\nsingle / sequential / concurrent\nhandoff / group_chat / magentic"]
    end

    subgraph GW["Gateway Client → Bifrost (external LLM router)"]
        LGW["llm_gateway.py\nvalidate · retry · track tokens · fetch project VK"]
        BF2["Bifrost :4001\nroutes azure/gpt-5.4 → Azure OpenAI\nroutes anthropic/... → Anthropic\nroutes openai/... → OpenAI · Bedrock\nenforces per-project VK budgets"]
    end

    subgraph MCP["MCP Layer"]
        MGR["mcp_manager.py"]
        REG["tool_registry.py"]
        TF["transport_factory.py\nhttp · sse · stdio"]
    end

    MCP_SRV[("MCP Servers\ngithub · duckdb · weather · …")]
    CS[("config-service\nagent configs · VK · MCP records")]

    U --> IF
    IF --> GR
    GR --> FW
    FW --> EXEC
    EXEC --> SK & CR & LG
    SK & CR & LG --> ORCH
    ORCH --> GW
    ORCH --> MCP
    GW -->|"GET /projects/:id/models/:hint"| CS
    MCP --> TF --> MCP_SRV
```

---

## 2. Config-service Interactions

```mermaid
sequenceDiagram
    autonumber
    participant MAF as agent-service-maf
    participant CS as config-service
    participant BF as Bifrost Gateway

    Note over MAF,CS: Startup / first request (TTL-cached)

    MAF->>CS: GET /api/v1/projects/:id/agent-teams/:teamId
    CS-->>MAF: team config (agents, orchestration, tools)

    MAF->>CS: GET /api/v1/projects/:id/agents/:agentId
    CS-->>MAF: agent config (instructions, model, mcp_servers)

    MAF->>CS: GET /api/v1/projects/:id/mcp-servers/:serverId
    CS-->>MAF: MCP server record (url, transport, auth_token)

    Note over MAF,BF: Per LLM call (60s TTL cache)

    MAF->>CS: GET /api/v1/projects/:id/models/:hint
    CS-->>MAF: gatewayApiKey + gatewayModelId

    MAF->>BF: POST /v1/chat/completions<br/>Authorization: Bearer gatewayApiKey<br/>model: azure/gpt-5.4
    BF-->>MAF: LLM response
```

---

## 3. Single Request Flow — GitHub Assistant

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant GR as Guardrails
    participant SK as SemanticKernel adapter
    participant BF as Gateway Client → Bifrost :4001
    participant MCP as MCP Manager
    participant GH as GitHub MCP Server

    U->>GR: "How many stars does fastapi have?"
    GR->>GR: input_validator (length check) ✅
    GR->>SK: message passed

    SK->>BF: complete_with_tools(messages, tools=[github.*])<br/>Authorization: Bearer bk-proj-xxx (project VK)<br/>model: azure/gpt-5.4
    BF-->>SK: tool_call: github.search_repositories({query:"fastapi"})

    SK->>MCP: execute tool github.search_repositories
    MCP->>GH: POST /mcp  search_repositories({query:"fastapi"})<br/>Authorization: Bearer SA-token  X-User-Token: user-JWT
    GH-->>MCP: {name:"tiangolo/fastapi", stars:84231, ...}

    MCP->>SK: tool result
    SK->>BF: complete_with_tools(messages + tool_result)<br/>model: azure/gpt-5.4
    BF-->>SK: "tiangolo/fastapi has 84,231 stars."

    SK->>GR: output guardrails check ✅
    GR->>U: SSE stream — "tiangolo/fastapi has 84,231 stars."
```

---

## 4. DuckDB Analytics — Magentic Multi-Agent Flow

```mermaid
flowchart TD
    U([User: Which country had highest GDP growth?])

    subgraph MAF["agent-service-maf"]
        subgraph MAGENTIC["Magentic Orchestrator — GPT-5.4 temp=0.0"]
            MGR_LLM["Manager LLM\ndecides: who goes next?"]
        end

        subgraph SS["schema-scout — GPT-5.4 temp=0.0"]
            SS_TOOLS["✅ list_databases\n✅ list_tables\n✅ list_columns\n❌ execute_query  FORBIDDEN"]
        end

        subgraph SA["sql-author — GPT-5.4 temp=0.0"]
            SA_TOOLS["❌ list_* FORBIDDEN\n✅ execute_query\nwrites DuckDB SQL"]
        end

        subgraph II["insight-interpreter — GPT-5.4 temp=0.2"]
            II_TOOLS["NO TOOLS\nreads raw rows\nwrites plain-English answer"]
        end
    end

    DUCK[("proj3mo8iwpr_duck_db\nDuckDB MCP Server\n:4001/mcp")]
    BF[("Bifrost\nazure/gpt-5.4")]

    U --> MGR_LLM
    MGR_LLM -->|"Round 1: discover schema"| SS
    SS -->|"list_databases, list_tables, list_columns"| DUCK
    DUCK -->|"catalog=iceberg, table=gdp, columns=[country,year,growth_pct]"| SS
    SS -->|"schema summary"| MGR_LLM

    MGR_LLM -->|"Round 2: query the data"| SA
    SA -->|"execute_query: SELECT country, growth_pct FROM iceberg.proj3mo8iwpr.gdp WHERE year=(SELECT MAX...) ORDER BY growth_pct DESC LIMIT 50"| DUCK
    DUCK -->|"rows: [{Guyana, 62.3}, {Ethiopia, 9.1}, ...]"| SA
    SA -->|"raw rows + SQL"| MGR_LLM

    MGR_LLM -->|"Round 3: interpret"| II
    II -->|"plain-English answer"| MGR_LLM
    MGR_LLM -->|"complete"| U

    SS & SA & II ---|"all LLM calls"| BF

    style SS fill:#dbeafe
    style SA fill:#dcfce7
    style II fill:#fef9c3
    style MGR_LLM fill:#f3e8ff
```

---

## 5. Orchestration Types — At a Glance

```mermaid
flowchart LR
    subgraph SEQ["sequential"]
        direction LR
        A1[agent1] --> A2[agent2] --> A3[agent3]
    end

    subgraph CON["concurrent"]
        direction TB
        B0([input]) --> B1[agent1] & B2[agent2] & B3[agent3]
        B1 & B2 & B3 --> B4([merge])
    end

    subgraph HO["handoff"]
        direction LR
        C1[triage] -->|billing q| C2[billing]
        C1 -->|tech q| C3[technical]
        C2 -->|re-route| C1
        C3 -->|re-route| C1
    end

    subgraph MAG["magentic"]
        direction TB
        D0([Manager LLM]) -->|decides| D1[agent A]
        D1 --> D0
        D0 -->|decides| D2[agent B]
        D2 --> D0
        D0 -->|done| D3([answer])
    end
```

---

## 6. Framework Adapters — SemanticKernel vs CrewAI vs LangGraph

MAF is designed to support multiple agent frameworks through adapters. Each framework has different strengths and philosophies:

### 6.1 SemanticKernel (Microsoft)

**Philosophy:** Function-calling and .NET-first approach

```python
# SemanticKernel style - Structured function calling
kernel = Kernel()
kernel.add_plugin(GitHubPlugin())
kernel.add_plugin(JiraPlugin())

result = await kernel.invoke_prompt(
    "Create a GitHub issue based on Jira ticket ABC-123"
)
```

**Key Characteristics:**
- **Language:** C# first-class, Python secondary
- **Approach:** Structured function calling (like OpenAI function calling)
- **Best for:** Enterprise .NET developers, structured prompt engineering
- **Strengths:** Strong typing, enterprise integration, structured templates

**Use Cases:**
- Enterprise .NET applications
- Structured workflows with function calls
- Microsoft ecosystem integration

---

### 6.2 CrewAI

**Philosophy:** Role-based multi-agent collaboration

```python
# CrewAI style - Agents with roles working as a crew
researcher = Agent(
    role='Senior Researcher',
    goal='Find accurate information',
    backstory='Expert at web research...',
    tools=[search_tool, scrape_tool]
)

writer = Agent(
    role='Content Writer',
    goal='Write engaging articles',
    backstory='Award-winning writer...',
    tools=[writing_tool]
)

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, writing_task],
    process=Process.sequential  # or hierarchical
)

result = crew.kickoff()
```

**Key Characteristics:**
- **Language:** Python only
- **Approach:** Agents with roles working together as a "crew"
- **Best for:** Multi-agent systems with clear role divisions
- **Strengths:** Role-based design, task delegation, high-level abstractions

**Use Cases:**
- Multi-agent workflows (research → write → review)
- Role-based task division (like a real team)
- Content creation, analysis pipelines

---

### 6.3 LangGraph

**Philosophy:** Graph-based stateful workflows with cycles

```python
# LangGraph style - State machines with conditional branching
from langgraph.graph import StateGraph

workflow = StateGraph(AgentState)

# Add nodes (steps)
workflow.add_node("research", research_agent)
workflow.add_node("write", writer_agent)
workflow.add_node("validate", validator)

# Add edges (flow control)
workflow.add_edge("research", "write")
workflow.add_conditional_edges(
    "validate",
    should_retry,
    {
        "retry": "write",      # Loop back if validation fails
        "done": END            # Exit if validation passes
    }
)

workflow.set_entry_point("research")
app = workflow.compile()
result = app.invoke({"query": "..."})
```

**Key Characteristics:**
- **Language:** Python only
- **Approach:** State machines / directed graphs
- **Best for:** Complex workflows with branching, loops, human-in-the-loop
- **Strengths:** Cycles/loops, conditional branching, state persistence, human approval gates

**Use Cases:**
- Iterative workflows (generate → test → fix loop)
- Human approval gates
- Complex branching logic
- Stateful conversations with memory

---

### 6.4 Comparison Matrix

| Feature | SemanticKernel | CrewAI | LangGraph |
|---------|----------------|--------|-----------|
| **Programming Model** | Function calling | Role-based agents | State graph |
| **Primary Language** | C# (.NET) | Python | Python |
| **Multi-agent** | ❌ Single agent focused | ✅ Multi-agent by design | ✅ Multiple nodes/agents |
| **Loops/Cycles** | ⚠️ Limited | ⚠️ No explicit cycles | ✅ Built-in support |
| **State Management** | ✅ Memory system | ⚠️ Basic | ✅ Advanced (StateGraph) |
| **Human-in-loop** | ❌ | ❌ | ✅ Native support |
| **Branching Logic** | ⚠️ Manual | ⚠️ Process-based | ✅ Conditional edges |
| **Complexity** | Low-Medium | Medium | High |
| **Learning Curve** | Easy | Easy | Moderate |
| **Best For** | Enterprise .NET | Role-based teams | Complex workflows |

---

### 6.5 Visual Flow Comparison

**SemanticKernel Workflow:**
```
User Query → Planner → [Tool1, Tool2, Tool3] → Response
             (linear with function calls)
```

**CrewAI Workflow:**
```
Task 1 → Researcher Agent → output
Task 2 → Writer Agent → output (uses researcher's output)
Task 3 → Editor Agent → final output
(sequential or hierarchical handoff)
```

**LangGraph Workflow:**
```
Start → Research → Write → Validate
                             ↓
                          Pass? 
                    No ↙       ↘ Yes
              Revise (loop back)  End
(graph with cycles and conditions)
```

---

### 6.6 When to Use Each Framework

**Use SemanticKernel when:**
- Building .NET applications
- Need strong typing and IDE support
- Want structured function calling
- Enterprise Microsoft ecosystem integration
- **Example:** Customer support bot with structured tool calls

**Use CrewAI when:**
- Multi-agent collaboration (like a team)
- Clear role separation (researcher, writer, reviewer)
- Sequential or hierarchical workflows
- Want high-level abstractions
- **Example:** Research paper writing (researcher → writer → editor)

**Use LangGraph when:**
- Complex workflows with branching
- Need loops/retry logic
- Human approval gates required
- Stateful multi-turn conversations
- **Example:** Code generation with validation (write → test → fix loop)

---

### 6.7 MAF Integration Strategy

All three frameworks will be integrated through the **adapter pattern**:

```mermaid
flowchart TD
    REQ["User Request"]
    GUARD["Guardrails Layer"]
    
    subgraph ADAPTERS["Framework Adapters"]
        SK["SemanticKernel<br/>Adapter"]
        CR["CrewAI<br/>Adapter"]
        LG["LangGraph<br/>Adapter"]
    end
    
    GW["llm_gateway.py<br/>(unified LLM calls)"]
    MCP["MCP Manager<br/>(unified tools)"]
    BF["Bifrost<br/>(LLM provider)"]
    
    REQ --> GUARD
    GUARD --> SK
    GUARD --> CR
    GUARD --> LG
    SK --> GW
    CR --> GW
    LG --> GW
    SK --> MCP
    CR --> MCP
    LG --> MCP
    GW --> BF
```

**Key Design Principle:**
> All adapters funnel through the same `llm_gateway.py` and `mcp_manager.py` — ensuring uniform auth, rate limiting, usage tracking, and guardrails regardless of which framework the user chooses.

---

### 6.8 Current Status

**All three frameworks are PLANNED, not yet implemented:**

| Framework | Status | Priority |
|-----------|--------|----------|
| SemanticKernel | 🔮 Planned | TBD |
| CrewAI | 🔮 Planned | TBD |
| LangGraph | 🔮 Planned | TBD |

**Current implementation:** Custom orchestration layer with direct LLM and MCP integration. Framework adapters are future enhancements to provide multiple execution models for different use cases.

---

## 7. Tool Partitioning Pattern

A key design in MAF is **strict tool partitioning** — each agent in a team is
restricted to a subset of available tools, even though all tools are technically
visible. Enforcement is via system-prompt instructions, not API-level access
control.

```mermaid
flowchart TD
    subgraph MCP_TOOLS["DuckDB MCP — available tools"]
        T1["list_databases"]
        T2["list_tables"]
        T3["list_columns"]
        T4["execute_query"]
    end

    subgraph AGENTS["agents"]
        SS["schema-scout\nDISCOVERY ONLY"]
        SA["sql-author\nEXECUTION ONLY"]
        II["insight-interpreter\nNO TOOLS"]
    end

    T1 & T2 & T3 -->|"allowed"| SS
    T4 -.->|"visible but FORBIDDEN\nby prompt"| SS

    T4 -->|"allowed"| SA
    T1 & T2 & T3 -.->|"visible but FORBIDDEN\nby prompt"| SA

    T1 & T2 & T3 & T4 -.->|"not used"| II
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Single `llm_gateway.py` entry point | Adapters (SK/CrewAI/LangGraph) cannot call LLM providers directly — all traffic goes through one place for retry, auth, and usage tracking |
| Per-project Bifrost virtual key | Rate limits and budgets are scoped per project; falling back to a cluster master key would bypass them |
| `discovery_on_connect: true` | MCP tool list is fetched dynamically at connect time — no need to hardcode tool names in configs |
| `lazy_connect: true` (default) | MCP connections are opened on first use, not at startup — reduces idle resource usage |
| TTL cache for config-service fetches | Avoids hammering config-service on every LLM call; 60s TTL balances freshness vs. load |
| Fail-fast guardrails (`fail_open: false`) | On guardrail error the request is blocked, not passed through — security over availability |

---

## 8. Per-Project Agentic Call Flow

Every project in AgentStudio is fully isolated: its own agent configs, its own
MCP servers, and its own Bifrost virtual key (VK) that enforces per-project
rate limits and budgets. Here is the full lifecycle for a single request.

### Phase 1 — Bootstrapping (first request for a project/team)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant MAF as agent-service-maf
    participant CS as config-service
    participant K8S as K8s Secrets

    U->>MAF: POST /chat {project_id:"project1", team_id:"team-abc"}

    Note over MAF,CS: All fetches are TTL-cached (60s)

    MAF->>CS: GET /projects/project1/agent-teams/team-abc
    CS-->>MAF: {agents:["agent-1"], mcp_servers:["server-A"], model:"azure/gpt-5.4"}

    MAF->>CS: GET /projects/project1/agents/agent-1
    CS-->>MAF: {instructions:"...", mcpServerIds:["mcp-A-id"], model:"azure/gpt-5.4"}

    MAF->>CS: GET /projects/project1/mcp-servers/mcp-A-id
    CS-->>MAF: {name:"server-A", url:"http://mcp-A:8080", credentials:{secret_name:"..."}}

    MAF->>K8S: fetch credential secret for server-A
    K8S-->>MAF: {api_key: "sk-..."}

    MAF->>CS: GET /projects/project1/models/azure-gpt-5.4-id
    CS-->>MAF: {gatewayApiKey:"bk-proj-project1-xxx", gatewayModelId:"azure/gpt-5.4"}
```

### Phase 2 — MCP Connection and Tool Discovery

```mermaid
sequenceDiagram
    autonumber
    participant MAF as MCPConnectionManager
    participant MCP as MCP Server A
    participant TR as ToolRegistry

    MAF->>MCP: connect (streamable-http)<br/>Authorization: Bearer SA-token<br/>X-User-Token: Bearer user-JWT<br/>X-User-ID: user-123<br/>X-Project-ID: project1

    Note over MAF,MCP: discovery_on_connect = true

    MAF->>MCP: list_tools()
    MCP-->>MAF: [{name:"search", inputSchema:{query,limit}},<br/>{name:"get_item", inputSchema:{id}}]

    MAF->>TR: register "server-A.search"
    MAF->>TR: register "server-A.get_item"

    Note over TR: tool_name_format = "qualified"<br/>→ "server-A.search" not just "search"
```

### Phase 3 — LLM Call + Tool Execution

```mermaid
sequenceDiagram
    autonumber
    participant SK as SemanticKernel
    participant LGW as LLM Gateway
    participant BF as Bifrost :4001
    participant TG as Tool Guardrail
    participant MCP as MCP Server A

    SK->>LGW: complete_with_tools(messages, tools=[server-A.search, server-A.get_item])

    LGW->>BF: POST /v1/chat/completions<br/>Authorization: Bearer bk-proj-project1-xxx<br/>model: azure/gpt-5.4<br/>tools: [server-A.search, server-A.get_item]

    BF-->>LGW: tool_call: server-A.search({query:"X"})

    LGW->>SK: tool_call received

    SK->>TG: check: calls_so_far < max_calls_per_request (20)?
    TG-->>SK: ✅ allowed

    SK->>MCP: call server-A.search({query:"X"})<br/>Authorization: Bearer SA-token<br/>X-User-Token: Bearer user-JWT<br/>X-Project-ID: project1

    MCP-->>SK: {results: [...]}

    SK->>LGW: complete_with_tools(messages + tool_result)
    LGW->>BF: POST /v1/chat/completions (2nd call — final answer)
    BF-->>LGW: "Here are the results for X..."

    LGW->>SK: final text → SSE stream → User
```

### Phase 4 — Project Isolation

Each project gets its own cached slice. No cross-project bleed.

```mermaid
flowchart LR
    subgraph P1["project1"]
        P1VK["VK: bk-proj-p1-xxx\nrate-limit: 1000 rpm"]
        P1MCP["MCP Server A\nhttp://mcp-A:8080"]
        P1M["Model: azure/gpt-5.4"]
    end

    subgraph P2["project2"]
        P2VK["VK: bk-proj-p2-yyy\nrate-limit: 500 rpm"]
        P2MCP["MCP Server B\nhttp://mcp-B:9090"]
        P2M["Model: anthropic/claude-sonnet"]
    end

    subgraph CACHE["RemoteConfigCache — TTL 60s"]
        C1["agent:(p1, agent-1)"]
        C2["mcp:(p1, server-A-id)"]
        C3["vk: p1 → bk-proj-p1-xxx"]
        C4["agent:(p2, agent-2)"]
        C5["mcp:(p2, server-B-id)"]
        C6["vk: p2 → bk-proj-p2-yyy"]
    end

    BF[("Bifrost Gateway\nenforces VK budgets")]

    P1VK & P2VK --> BF
    P1 --> C1 & C2 & C3
    P2 --> C4 & C5 & C6
```

### Two-Token Model — How MCP Auth Works

Every outbound MCP HTTP call carries two distinct authorization concerns:

| Header | Value | Purpose |
|---|---|---|
| `Authorization` | `Bearer <SA service_token>` | Proves "this is MAF calling" (service identity) |
| `X-User-Token` | `Bearer <user JWT>` | On-behalf-of the human user |
| `X-User-ID` | `user-123` | Attribution |
| `X-Project-ID` | `project1` | Project context for the MCP server |
| `X-User-Email` | `mrinal@...` | Attribution |

> **Legacy fallback:** when no `service_token` is configured, the user JWT is
> sent as `Authorization` (preserving backward compatibility). Once all MCP
> servers read `X-User-Token`, the fallback can be retired.

### Cache TTL Summary

| What | Cache key | TTL |
|---|---|---|
| Team config | `(project_id, team_id)` | 60s |
| Agent config | `(project_id, agent_id)` | 60s |
| MCP server record | `(project_id, server_id)` | 60s |
| Per-project VK | `project_id` | 60s |
| Model record | `(project_id, model_id)` | 60s |
| KB record | `(project_id, kb_id)` | 60s |
| MCP tool list | physical endpoint URL | session lifetime |

---

## 9. Bifrost Virtual Keys, Teams, and LLM Call Security

This section covers how per-project LLM access is scoped and secured — from
the Bifrost team/VK created at project init, through the secret storage chain,
to the final call reaching Azure OpenAI (or any other provider).

---

### 8.1 Core Concepts

| Concept | What it is | Analogy |
|---|---|---|
| **Bifrost Team** | An isolated namespace in Bifrost, 1:1 with an AgentStudio project | Bank account |
| **VK ID** (`virtualKeyId`) | UUID identifying the Virtual Key in Bifrost — used to manage it | Account number |
| **VK Token** (`bk-proj-xxx`) | The actual bearer token sent on LLM calls — proves project identity | Debit card PIN |
| **Provider Key** | The cloud provider's own API key (Azure, Anthropic, etc.) stored in Bifrost's keystore | Card stored in wallet |

```mermaid
flowchart LR
    subgraph AS["AgentStudio"]
        P["Project\nprojmf8jf5qs"]
    end

    subgraph BF["Bifrost"]
        T["Team\nas-proj-projmf8jf5qs"]
        VK["Virtual Key\nas-proj-projmf8jf5qs-vk\nvk_id: 'vk-uuid'\ntoken: 'bk-proj-xxx'"]
        PC["provider_configs\nprovider: azure\nallowed_models: gpt-5.4\nkey_ids: provider-key-uuid"]
        PK["Provider Key\nvalue: sk-azure-xxxxx"]
    end

    P -->|"1:1 mapping"| T
    T -->|"owns"| VK
    VK -->|"controls"| PC
    PC -->|"references"| PK
```

---

### 8.2 Project Init — When Team and VK are Created

The Bifrost team and VK are **not** created when the user clicks "Create Project".
They are created asynchronously by `ProjectInitWorkflow` (Temporal) a few
seconds later.

```mermaid
sequenceDiagram
    autonumber
    participant UI as Browser UI
    participant CS as config-service
    participant WE as workflow-engine (Temporal)
    participant BF as Bifrost
    participant K8S as K8s Secrets
    participant DB as PostgreSQL

    UI->>CS: POST /api/v1/projects {name:"testProject"}
    CS->>DB: INSERT projects {id:"projmf8jf5qs", metadata:{}}
    CS-->>UI: 201 Created (project row exists, no team yet)

    CS--)WE: POST /projects/projmf8jf5qs/init (async)

    Note over WE,BF: ProjectInitWorkflow Step 0 — gateway setup

    WE->>CS: POST /internal/projects/projmf8jf5qs/gateway-setup
    CS->>BF: POST /api/teams {name:"as-proj-projmf8jf5qs"}<br/>Authorization: Bearer LLM_GATEWAY_API_KEY (admin)
    BF-->>CS: {id: "team-uuid-xxx"}

    CS->>BF: POST /api/virtual-keys {team_id:"team-uuid-xxx"}
    BF-->>CS: {id:"vk-uuid-yyy", key:"bk-proj-xxx..."}

    CS->>DB: UPDATE projects SET metadata._gateway =<br/>{teamId:"team-uuid-xxx", virtualKeyId:"vk-uuid-yyy"}
    CS->>K8S: create secret "as-proj-projmf8jf5qs-vk"<br/>{virtual_key_token: "bk-proj-xxx..."}
    CS-->>WE: {teamId, virtualKeyId}

    Note over WE: Steps 1-N: Keycloak, Lakekeeper, built-in models...
```

> **Idempotency:** `ensureProjectGateway()` checks the DB cache first. If
> `metadata._gateway.teamId` exists and is still valid in Bifrost, it skips
> creation. Safe to retry from Temporal on failure.

---

### 8.3 VK Token Storage — Two Copies, Two Purposes

```mermaid
flowchart TD
    BF_STORE[("Bifrost keystore\nSource of truth\nbk-proj-xxx created here\nvalidates every LLM call")]
    K8S_STORE[("K8s Secret\nas-proj-projmf8jf5qs-vk\nvirtual_key_token: bk-proj-xxx\nRecovery copy")]
    DB_STORE[("PostgreSQL\nprojects.metadata._gateway\nvirtualKeyId: vk-uuid\nteamId: team-uuid\nNO token here")]

    CS["config-service"]
    MAF["agent-service-maf"]

    CS -->|"reads token for MAF"| K8S_STORE
    CS -->|"manages VK lifecycle"| BF_STORE
    CS -->|"stores IDs only"| DB_STORE
    MAF -->|"requests token"| CS

    style BF_STORE fill:#dbeafe
    style K8S_STORE fill:#dcfce7
    style DB_STORE fill:#fef9c3
```

| Store | What's kept | Who reads it | Recovery role |
|---|---|---|---|
| Bifrost | Full VK token (validates calls) | Itself only | Source of truth |
| K8s Secret | `virtual_key_token` | config-service → MAF | If K8s deleted, must rotate |
| PostgreSQL | `virtualKeyId`, `teamId` (no token) | config-service (management) | Used to find + recreate in Bifrost |

---

### 8.4 MAF → Azure OpenAI: Full Secret Chain

```mermaid
sequenceDiagram
    autonumber
    participant MAF as agent-service-maf
    participant CS as config-service
    participant K8S as K8s Secret
    participant BF as Bifrost :4001
    participant AZ as Azure OpenAI

    Note over MAF: ProjectVKResolver — 60s TTL cache

    MAF->>CS: GET /projects/p1/models/model-id<br/>Authorization: Bearer SA-token (service lane)
    CS->>K8S: readSecret("as-proj-p1-vk")
    K8S-->>CS: {virtual_key_token: "bk-proj-xxx"}
    CS-->>MAF: {gatewayModelId:"azure/gpt-5.4", gatewayApiKey:"bk-proj-xxx"}

    Note over MAF: caches bk-proj-xxx for 60s

    MAF->>BF: POST /v1/chat/completions<br/>Authorization: Bearer bk-proj-xxx<br/>model: azure/gpt-5.4<br/>messages: [...]

    Note over BF: RBAC check against VK provider_configs

    BF->>BF: validate bk-proj-xxx → team as-proj-p1<br/>provider_configs has azure/gpt-5.4? ✅<br/>fetch azure api-key from keystore

    BF->>AZ: POST /openai/deployments/gpt-5.4/chat/completions<br/>api-key: sk-azure-xxxxx<br/>messages: [...]
    AZ-->>BF: {choices:[...]}
    BF-->>MAF: LLM response
```

> **Security boundary:** MAF only ever sees `bk-proj-xxx` (the VK token).
> The Azure API key (`sk-azure-xxxxx`) is fetched by Bifrost from its own
> keystore and **never leaves Bifrost**. MAF has no knowledge of it.

---

### 8.5 How Bifrost Enforces Provider Access Control

When a model is registered, config-service updates the project's VK
`provider_configs` in Bifrost:

```mermaid
flowchart TD
    REG["User registers 'Azure GPT-5.4' model"]
    CS["config-service bifrostProjectGovernance.addModel()"]
    CS2["1. readSecretData(credentialId) → sk-azure-xxx from K8s"]
    CS3["2. POST /api/providers/azure/keys<br/>{value: sk-azure-xxx}"]
    CS4["3. PUT /api/virtual-keys/{vkId}<br/>provider_configs: [{<br/>  provider: azure,<br/>  allowed_models: [gpt-5.4, azure/gpt-5.4],<br/>  key_ids: [provider-key-uuid]<br/>}]"]

    REG --> CS --> CS2 --> CS3 --> CS4
```

**At call time, Bifrost enforces three checks:**

```mermaid
flowchart TD
    CALL["MAF calls model: anthropic/claude-sonnet"]

    C1{"Provider 'anthropic'\nin VK provider_configs?"}
    C2{"Model 'claude-sonnet'\nin allowed_models?"}
    C3{"provider_configs has\na key_id?"}

    OK["✅ Route to Anthropic API"]
    F1["❌ 403 RBAC: access denied\n(provider not registered)"]
    F2["❌ 403 RBAC: access denied\n(model not allowed)"]
    F3["❌ 403 RBAC: access denied\n(no API key)"]

    CALL --> C1
    C1 -->|No| F1
    C1 -->|Yes| C2
    C2 -->|No| F2
    C2 -->|Yes| C3
    C3 -->|No| F3
    C3 -->|Yes| OK
```

**Examples with only Azure registered:**

| Call attempt | Check result | Response |
|---|---|---|
| `azure/gpt-5.4` | azure ✅ model ✅ key ✅ | 200 OK |
| `azure/gpt-99` | azure ✅ model ❌ | 403 RBAC |
| `anthropic/claude-sonnet` | anthropic ❌ | 403 RBAC |
| `openai/gpt-4o` | openai ❌ | 403 RBAC |

---

### 8.6 Where Each Secret Lives — Summary

```mermaid
flowchart LR
    subgraph CS_SVC["config-service"]
        A["LLM_GATEWAY_API_KEY\n(admin token for Bifrost)"]
    end

    subgraph K8S["K8s Secrets"]
        B["as-proj-{projectId}-vk\nvirtual_key_token: bk-proj-xxx"]
        C["credential-{id}-secret\napi_key: sk-azure-xxx"]
    end

    subgraph BF_STORE["Bifrost keystore"]
        D["VK: bk-proj-xxx\n(validates LLM calls)"]
        E["Provider key: sk-azure-xxx\n(calls Azure at runtime)"]
    end

    subgraph DB["PostgreSQL"]
        F["projects.metadata._gateway\nteamId, virtualKeyId\n(NO token)"]
        G["credentials table\nname, provider, metadata\n(NO secret data)"]
    end

    CS_SVC -->|"creates team+VK"| BF_STORE
    CS_SVC -->|"reads token to give MAF"| K8S
    CS_SVC -->|"pushes Azure key"| BF_STORE
    CS_SVC -->|"saves IDs"| DB
```


---

---

### 8.7 Virtual Key Token Deep Dive — What Is It & Why?

This subsection answers common questions about the VK token that config-service
stores in K8s secrets and how it's used by agent-service-maf.

---

#### Q: What exactly is the Virtual Key token?

The **Virtual Key Token** (format: `bk-proj-{projectId}-xxx`) is a **per-project bearer token** that agent-service-maf uses to authenticate **ALL LLM calls** to Bifrost on behalf of that project.

**Think of it as:**
- Bifrost Team = Bank account (project's namespace)
- VK Token = Debit card PIN (proves you own the account)
- Provider Key = Card stored in bank vault (used at payment time)

**Example:**
```
Project ID: projmf8jf5qs
VK Token:   bk-proj-projmf8jf5qs-a7f2c9e4
```

---

#### Q: Where is it stored?

**Three locations, each with a specific purpose:**

| Location | What's Stored | Who Reads It | Purpose |
|----------|---------------|--------------|---------|
| **Bifrost keystore** | Full VK token | Bifrost itself | **Source of truth** - validates every LLM call |
| **K8s Secret** | Full VK token | config-service | **Runtime access** - gives token to MAF when needed |
| **PostgreSQL** | VK ID + Team ID only | config-service | **Management** - track which project owns which VK |

**K8s Secret Structure:**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: as-proj-projmf8jf5qs-vk      # Pattern: as-proj-{projectId}-vk
  namespace: agentstudio-services
  labels:
    app: agentstudio
    component: llm-gateway
    project-id: projmf8jf5qs
type: Opaque
data:
  # Base64 encoded VK token
  virtual_key_token: YmstcHJvai1wcm9qbWY4amY1cXMtYTdmMmM5ZTQ...
```

**Why not store in PostgreSQL?**
- ✅ DB dumps don't leak VK tokens
- ✅ SQL injection can't steal tokens  
- ✅ Backups don't contain sensitive credentials
- ✅ K8s encryption at rest + RBAC protection

---

#### Q: When is it created?

**During ProjectInitWorkflow (async, ~few seconds after project creation):**

```mermaid
sequenceDiagram
    autonumber
    participant UI
    participant CS as config-service
    participant WE as workflow-engine
    participant BF as Bifrost
    participant K8S

    UI->>CS: POST /api/v1/projects {name: "My Project"}
    CS->>CS: INSERT projects row
    CS-->>UI: 201 Created {id: "proj123"}
    
    Note over CS,WE: Async workflow starts
    
    CS--)WE: Trigger ProjectInitWorkflow
    WE->>CS: POST /internal/.../gateway-setup
    
    CS->>BF: POST /api/teams {name: "as-proj-proj123"}
    BF-->>CS: {id: "team-uuid"}
    
    CS->>BF: POST /api/virtual-keys {team_id: "team-uuid"}
    BF-->>CS: {id: "vk-uuid", key: "bk-proj-proj123-xxx"}
    
    Note over CS: Store VK token in K8s
    CS->>K8S: Create secret "as-proj-proj123-vk"
    
    Note over CS: Store IDs in DB (not token!)
    CS->>CS: UPDATE projects.metadata._gateway
```

**Important:** The project row exists immediately, but VK creation happens asynchronously (~2-5 seconds later).

---

#### Q: How does MAF get the VK token at runtime?

**On every LLM call (with 60s TTL caching):**

```mermaid
sequenceDiagram
    autonumber
    participant MAF as agent-service-maf
    participant CS as config-service
    participant K8S
    participant BF as Bifrost
    participant AZ as Azure OpenAI

    Note over MAF: Agent needs to call LLM
    
    MAF->>CS: GET /projects/proj123/models/{hint}
    Note right of MAF: Authorization: Bearer SA-token
    
    CS->>K8S: readSecret("as-proj-proj123-vk")
    K8S-->>CS: {virtual_key_token: "bk-proj-proj123-xxx"}
    
    CS-->>MAF: {<br/>  gatewayApiKey: "bk-proj-proj123-xxx",<br/>  gatewayModelId: "azure/gpt-5.4"<br/>}
    
    Note over MAF: Cache token for 60s
    
    MAF->>BF: POST /v1/chat/completions
    Note right of MAF: Authorization: Bearer bk-proj-proj123-xxx<br/>model: azure/gpt-5.4
    
    BF->>BF: 1. Validate VK token<br/>2. Check project can use model<br/>3. Fetch Azure API key
    
    BF->>AZ: POST /.../chat/completions
    Note right of BF: api-key: sk-azure-xxxxx
    AZ-->>BF: LLM response
    BF-->>MAF: Response
```

**Key points:**
- MAF **never** sees the Azure API key (`sk-azure-xxxxx`)
- MAF only sees the VK token (`bk-proj-xxx`)
- VK token cached for 60s to reduce K8s lookups

---

#### Q: What does the VK token control?

**1. LLM Model Access (per-project allowlist):**

```yaml
# VK config in Bifrost
provider_configs:
  - provider: azure
    allowed_models: [gpt-4, gpt-5.4]
    key_ids: [azure-provider-key-uuid]
```

**Result:**
- ✅ `azure/gpt-5.4` → Allowed
- ✅ `azure/gpt-4` → Allowed
- ❌ `azure/gpt-99` → **403 RBAC** (not in allowed_models)
- ❌ `anthropic/claude` → **403 RBAC** (provider not configured)

**2. MCP Server Access (two-tier system):**

**Where MCP configs are stored:**
- ✅ **PostgreSQL** stores: Which MCP servers exist, which agents use them
  ```sql
  -- agents table
  SELECT id, name, mcpServerIds FROM agents WHERE id = 'agent-1';
  -- Result: {id: "agent-1", mcpServerIds: ["mcp-github-id", "mcp-duckdb-id"]}
  
  -- mcp_servers table
  SELECT id, name, url, sync_status FROM mcp_servers WHERE id = 'mcp-github-id';
  -- Result: {id: "mcp-github-id", name: "github", url: "http://...", sync_status: "synced"}
  ```

- ✅ **Bifrost VK** stores: Which MCP clients this project's VK can access
  ```yaml
  # VK config in Bifrost (updated during MCP sync)
  mcp_configs:
    - mcp_client_id: github-mcp-client-uuid  # Bifrost MCP client ID
      allowed_tools: [search, get_repo, create_pr]
  ```

**How it works:**
1. User adds MCP server → Saved to PostgreSQL `mcp_servers` table
2. config-service syncs → Registers MCP client in Bifrost
3. config-service binds → Updates VK's `mcp_configs` in Bifrost
4. Agent references MCP → `mcpServerIds: ["mcp-github-id"]` in PostgreSQL
5. MAF invokes agent → Reads `mcpServerIds` from PostgreSQL
6. MAF connects to MCP → VK must have `mcp_client_id` in Bifrost

**Result:**
- ✅ Agent can use GitHub MCP tools (if in agent's `mcpServerIds` AND VK's `mcp_configs`)
- ❌ Without VK binding, MCP server is unreachable (403 from Bifrost)

**3. Rate Limits & Budgets:**

```yaml
# VK config in Bifrost
rate_limit: 1000 rpm  # requests per minute
budget:
  max_spend_per_month: 100.00  # USD
  currency: USD
```

**Result:**
- Request 1001 in same minute → **429 Too Many Requests**
- Spend $100.01 in month → **402 Payment Required**

---

#### Q: Why use VK tokens instead of provider keys directly?

**Security: Two-Token Isolation Model**

```
┌──────────────────────────────────────────────────┐
│ MAF Layer                                         │
│   Sees: bk-proj-proj123-xxx (VK token)          │
│   ❌ Never sees: sk-azure-xxxxx (provider key)   │
└──────────────────────────────────────────────────┘
         ↓ Authorization: Bearer bk-proj-xxx
┌──────────────────────────────────────────────────┐
│ Bifrost Layer                                     │
│   Validates: bk-proj-proj123-xxx                 │
│   Fetches: sk-azure-xxxxx from keystore          │
│   Uses: sk-azure-xxxxx to call Azure             │
└──────────────────────────────────────────────────┘
         ↓ api-key: sk-azure-xxxxx
┌──────────────────────────────────────────────────┐
│ Azure OpenAI                                      │
│   Validates: sk-azure-xxxxx                      │
│   ❌ Never sees: bk-proj-xxx                     │
└──────────────────────────────────────────────────┘
```

**Benefits:**
1. **Blast radius containment:** If MAF compromised, attacker gets VK tokens (scoped to projects) but NOT provider keys (which access ALL projects)
2. **Per-project RBAC:** Each project has independent model allowlist, rate limits, budgets
3. **Centralized key rotation:** Rotate provider key in Bifrost once, affects all projects
4. **Audit trail:** Every LLM call has project-level attribution via VK token

---

#### Q: What happens if VK token is missing?

**Without VK token:**

```bash
# Direct Bifrost call without VK token
curl https://bifrost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "azure/gpt-5.4", "messages": [...]}'

# Response:
# 401 Unauthorized: Missing Authorization header
```

**With VK token:**

```bash
# Through MAF (succeeds)
curl https://bifrost:4001/v1/chat/completions \
  -H "Authorization: Bearer bk-proj-proj123-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "azure/gpt-5.4", "messages": [...]}'

# Bifrost:
# 1. ✅ Validates VK token
# 2. ✅ Checks project can use azure/gpt-5.4
# 3. ✅ Fetches Azure API key from keystore
# 4. ✅ Proxies to Azure OpenAI
# 5. ✅ Returns response
```

---

#### Q: How do MCP secrets differ from VK tokens?

**Different purposes, different lifecycle:**

| Aspect | VK Token | MCP Server Secret |
|--------|----------|-------------------|
| **Purpose** | Authenticate LLM calls to Bifrost | Authenticate MAF to MCP server |
| **Created** | ProjectInitWorkflow (async) | When user adds MCP server to project |
| **Format** | `bk-proj-{projectId}-xxx` | Varies (GitHub: `ghp_xxx`, DuckDB: none) |
| **Stored** | K8s: `as-proj-{projectId}-vk` | K8s: `mcp-{name}-env` or credential secret |
| **Used by** | MAF → Bifrost | MAF → MCP server |
| **Scope** | Per-project (1 VK per project) | Per-MCP-server (N secrets per project) |
| **Cached** | 60s by MAF | Resolved once in Phase 1 bootstrap |

**Example MCP secret (GitHub):**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-github-env
  namespace: agentstudio-services
type: Opaque
data:
  GITHUB_TOKEN: Z2hwX3h4eHh4eHh4eHg...  # base64("ghp_xxxxx")
```

**Used like:**
```
MAF → GitHub MCP Server
  Authorization: Bearer SA-token      ← MAF's service account
  X-User-Token: Bearer <user-jwt>     ← User's token
  X-Project-ID: proj123
  
  (GitHub MCP pod has GITHUB_TOKEN env var from secret)
```

---

#### Q: How do secrets get resolved in Phase 1 bootstrap?

**Complete flow from architecture Section 7, Phase 1:**

```mermaid
sequenceDiagram
    autonumber
    participant MAF
    participant CS as config-service
    participant K8S

    Note over MAF: User invokes agent

    MAF->>CS: GET /projects/proj1/agent-teams/team-abc
    CS-->>MAF: {agents: ["agent-1"], mcp_servers: ["server-A"]}

    MAF->>CS: GET /projects/proj1/agents/agent-1
    CS-->>MAF: {mcpServerIds: ["mcp-A-id"], model: "azure/gpt-5.4"}

    Note over MAF: MCP server config fetch
    MAF->>CS: GET /projects/proj1/mcp-servers/mcp-A-id
    CS-->>MAF: {url: "http://mcp-A:8080",<br/>credentials: {secret_name: "mcp-server-A-creds"}}

    Note over MAF: VK token fetch
    MAF->>CS: GET /projects/proj1/models/azure-gpt-5.4-id
    CS->>K8S: readSecret("as-proj-proj1-vk")
    K8S-->>CS: {virtual_key_token: "bk-proj-proj1-xxx"}
    CS-->>MAF: {gatewayApiKey: "bk-proj-proj1-xxx",<br/>gatewayModelId: "azure/gpt-5.4"}

    Note over MAF: MCP secret fetch
    MAF->>K8S: fetch secret "mcp-server-A-creds"
    K8S-->>MAF: {api_key: "sk-mcp-abc123"}

    Note over MAF: All secrets resolved!<br/>Proceed to Phase 2 (MCP connect)<br/>& Phase 3 (LLM calls)
```

**What's cached:**
- ✅ Agent config (60s TTL)
- ✅ MCP server config (60s TTL)
- ✅ VK token (60s TTL)
- ✅ MCP secrets (60s TTL)

**Why cache?**
- Second request within 60s skips ALL K8s lookups
- Performance: ~36% faster (780ms → 500ms in doc example)
- Reduced K8s API load

---

#### Summary

**VK Token = Project's LLM Access Pass**

| What | Value |
|------|-------|
| **Format** | `bk-proj-{projectId}-{random}` |
| **Created** | ProjectInitWorkflow (async) |
| **Stored** | K8s secret: `as-proj-{projectId}-vk` |
| **Used for** | Authenticate ALL LLM calls to Bifrost |
| **Controls** | Models, providers, MCP client access, rate limits, budgets |
| **Cached** | 60s by MAF |
| **Security** | MAF sees VK token, never provider keys |

**Key Insight:** VK token is the **abstraction layer** between AgentStudio projects and cloud provider API keys, enabling per-project RBAC, budgets, and blast radius containment.


## 10. MCP Server Sync: config-service → Bifrost

When a user adds an MCP server in the UI, config-service runs a multi-step
sync to register it in Bifrost and bind it to the project's virtual key.
Only after this sync is the MCP server reachable by agents.

### 9.1 Sync Flow

```mermaid
sequenceDiagram
    autonumber
    participant UI as Browser UI
    participant CS as config-service
    participant DB as PostgreSQL
    participant BF as Bifrost

    UI->>CS: POST /api/v1/projects/p1/mcp-servers<br/>{name:"github", url:"http://host.docker.internal:3333", transport:"http"}
    CS->>DB: INSERT mcp_servers {syncStatus:"pending"}
    CS-->>UI: 201 Created

    Note over CS,BF: Async sync begins

    CS->>DB: UPDATE syncStatus = "syncing"

    CS->>BF: POST /api/mcp/client<br/>Authorization: Bearer admin-token<br/>{name:"as-proj-p1-github",<br/> connection_type:"http",<br/> connection_string:"http://...",<br/> allow_on_all_virtual_keys: false}
    BF-->>CS: {client_id: "mcp-client-uuid"}

    CS->>BF: POST /api/mcp/client/mcp-client-uuid/reconnect
    BF-->>CS: 200 OK

    CS->>BF: PATCH disable auto-execute on client
    BF-->>CS: 200 OK

    Note over CS,BF: Bind client to project VK (critical step)

    CS->>BF: PUT /api/virtual-keys/{vkId}<br/>{mcp_configs: [{mcp_client_id:"mcp-client-uuid",<br/> allowed_tools:[...]}]}
    BF-->>CS: 200 OK

    CS->>DB: UPDATE syncStatus="synced"<br/>llmproxyGatewayServerId="mcp-client-uuid"

    UI->>CS: GET /mcp-servers (polling)
    CS-->>UI: {syncStatus:"synced", status:"active"} ✅
```

### 9.2 Why the VK Bind (Step 7) is Critical

Bifrost registers every MCP client with `allow_on_all_virtual_keys: false`.
This means a newly registered client is **unreachable** until explicitly
added to the project's VK `mcp_configs`.

```mermaid
flowchart TD
    REG["MCP client registered in Bifrost\nallow_on_all_virtual_keys: false"]
    NOBIND["Without VK bind\nMAF → Bifrost /mcp\n→ tool call → ❌ BLOCKED"]
    BIND["VK.mcp_configs updated\n[{mcp_client_id: uuid}]"]
    ALLOWED["MAF → Bifrost /mcp\n→ tool call → ✅ ALLOWED"]

    REG --> NOBIND
    REG --> BIND
    BIND --> ALLOWED
```

### 9.3 Sync Status Lifecycle

```mermaid
flowchart LR
    P["pending\n(just saved to DB)"]
    S["syncing\n(Bifrost registration in progress)"]
    A["synced / active\n(registered + VK bound)"]
    E["error\n(Bifrost call failed)"]

    P --> S
    S --> A
    S --> E
    E -->|"retry"| S
```

| Status | Meaning | Agent can use it? |
|---|---|---|
| `pending` | Queued for sync | ❌ |
| `syncing` | Bifrost registration running | ❌ |
| `synced` / `active` | Registered + bound to VK | ✅ |
| `error` | Bifrost call failed | ❌ |

### 9.4 Per-Agent Tool Scoping (after sync)

The VK `mcp_configs` is a **project-level** allowlist — all MCP servers
registered for the project. But individual agents only see their own tools.

```mermaid
flowchart TD
    subgraph VK["Project VK mcp_configs (all servers)"]
        S1["github MCP client"]
        S2["duckdb MCP client"]
        S3["weather MCP client"]
    end

    subgraph A1["Agent: GitHub Assistant\nmcpServerIds: [github]"]
        T1["github.search_repositories\ngithub.get_pull_request\ngithub.list_issues"]
    end

    subgraph A2["Agent: Analytics Bot\nmcpServerIds: [duckdb]"]
        T2["duckdb.execute_query\nduckdb.list_tables"]
    end

    S1 --> A1
    S2 --> A2
    S3 -.->|"not assigned\nto any agent"| X["unused"]
```

MAF sends `x-bf-mcp-include-tools` header per request so Bifrost enforces
the per-agent scope — even if the project VK has access to 5 MCP servers,
the agent only gets tools from its own configured servers.

---

## 11. Final Architecture — agent-service-maf with config-service

### 10.1 Layered Architecture (inside MAF)

```mermaid
flowchart TD
    U([User / UI])

    subgraph MAF["agent-service-maf"]
        subgraph IL["Interface Layer"]
            REST["REST routes"]
            SSE["SSE streaming"]
            WS["WebSocket"]
            AUTH["auth.py — JWT / SA token"]
        end

        subgraph GL["Guardrails Layer"]
            IG["Input: validator · prompt_injection · pii_masker"]
            OG["Output: content_filter · pii_masker · length"]
            TG["Tool: max_calls · denylist"]
        end

        subgraph FL["Framework / Executor Layer"]
            SK["SemanticKernel"]
            CR["CrewAI"]
            LG["LangGraph"]
            ORCH["Orchestration\nsingle · sequential · concurrent\nhandoff · group_chat · magentic"]
        end

        subgraph GC["Gateway Client"]
            LGW["llm_gateway.py\nvalidate · retry · track tokens"]
            VKR["project_vk_resolver.py\nfetch VK from config-service\n60s TTL cache"]
        end

        subgraph MCPL["MCP Manager"]
            MGR["mcp_manager.py\nconnect · reconnect"]
            TR["tool_registry.py\nserver.tool_name format"]
            TF["transport_factory.py\nhttp · sse · stdio"]
        end
    end

    BF[("Bifrost :4001\nroutes azure · anthropic\nopenai · bedrock")]
    MCP_SRV[("MCP Servers\ngithub · duckdb · weather")]
    CS[("config-service\n+ K8s Secrets")]

    U --> IL
    IL --> GL
    GL --> FL
    FL --> SK
    FL --> CR
    FL --> LG
    SK --> ORCH
    CR --> ORCH
    LG --> ORCH
    ORCH -->|"LLM call"| GC
    ORCH -->|"tool call"| MCPL
    GC -->|"VK fetch"| CS
    GC -->|"POST /v1/chat<br/>Bearer VK-token"| BF
    MCPL --> TF
    TF --> MCP_SRV
```

---

### 10.2 LLM Call Flow

```mermaid
sequenceDiagram
    autonumber
    participant FW as Framework
    participant GC as Gateway Client
    participant CS as config-service + K8s
    participant BF as Bifrost
    participant LLM as Azure / Anthropic

    FW->>GC: complete_with_tools(messages, tools)

    Note over GC,CS: ProjectVKResolver — 60s TTL cache
    GC->>CS: GET /projects/:id/models/:hint (service lane)
    CS-->>GC: {gatewayApiKey:"bk-proj-xxx", gatewayModelId:"azure/gpt-5.4"}

    GC->>BF: POST /v1/chat/completions<br/>Authorization: Bearer bk-proj-xxx<br/>model: azure/gpt-5.4  tools:[...]
    BF->>BF: validate VK → check provider_configs → fetch azure api-key
    BF->>LLM: POST Azure OpenAI  api-key: sk-azure-xxx
    LLM-->>BF: tool_call OR final answer
    BF-->>GC: response
    GC-->>FW: LLMCompletionResponse
```

---

### 10.3 Tool Call Flow (MCP)

```mermaid
sequenceDiagram
    autonumber
    participant FW as Framework
    participant MCPMgr as MCP Manager
    participant BF as Bifrost /mcp
    participant SRV as MCP Server (github)

    FW->>MCPMgr: execute tool "github.search_repositories" {query:"fastapi"}

    Note over MCPMgr: two-token model on every call
    MCPMgr->>BF: POST /mcp  tool: search_repositories<br/>Authorization: Bearer SA-token<br/>X-User-Token: Bearer user-JWT<br/>X-Project-ID: project1<br/>x-bf-mcp-include-tools: [github.*]

    BF->>BF: validate: mcp_client in VK mcp_configs? ✅<br/>tool in include-tools filter? ✅
    BF->>SRV: forward tool call
    SRV->>SRV: calls GitHub API with GITHUB_TOKEN
    SRV-->>BF: {name:"tiangolo/fastapi", stars:84231}
    BF-->>MCPMgr: tool result
    MCPMgr-->>FW: ToolResult
```

---

### 10.4 config-service Interactions

```mermaid
flowchart LR
    subgraph MAF["agent-service-maf"]
        RCC["RemoteConfigCache\n(TTL 60s)"]
        VKR["ProjectVKResolver\n(TTL 60s)"]
        MCPMgr["MCP Manager"]
    end

    subgraph CS["config-service"]
        API["REST API"]
        DB[("PostgreSQL\nagents · teams\nmcp_servers · models")]
        K8S[("K8s Secrets\nVK token\nAzure api-key\nGitHub token")]
    end

    RCC -->|"GET /projects/:id/agent-teams/:id"| API
    RCC -->|"GET /projects/:id/agents/:id"| API
    RCC -->|"GET /projects/:id/mcp-servers/:id"| API
    VKR -->|"GET /projects/:id/models/:hint\n(service lane only)"| API
    API --> DB
    API --> K8S

    subgraph BF["Bifrost"]
        VK["per-project VK\nbk-proj-xxx"]
        PC["provider_configs\nazure/gpt-5.4 ✅\nanthropic ❌"]
        MCC["mcp_configs\ngithub client ✅"]
    end

    CS -->|"admin token\ncreates team+VK\npushes azure key\nregisters MCP client"| BF
```

---

### 10.5 Complete Example: ONTAP MCP Credential Materialization

This shows the **end-to-end flow** for an infrastructure MCP (ONTAP) that requires credentials, from user setup through runtime tool calls.

#### Phase 1: Setup (config-service orchestrates everything)

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant CS as config-service
    participant DB as PostgreSQL
    participant K8S_CRED as K8s Secret<br/>(credential)
    participant K8S_MCP as K8s Secret<br/>(MCP per-server)
    participant POD as K8s Pod<br/>(ontap-mcp)
    participant BF as Bifrost

    Note over User,CS: 1. Create ONTAP Credential
    User->>CS: POST /credentials<br/>{provider: ontap, secretData: {username, password, client_cert_pem, ...}}
    CS->>K8S_CRED: Create Secret "as-cred-{credId}"
    K8S_CRED-->>CS: Stored
    CS->>DB: INSERT credentials
    CS-->>User: 201 Created

    Note over User,CS: 2. Create MCP Server
    User->>CS: POST /mcp-servers<br/>{templateId: ontap_mcp, credentialId: cred-123,<br/>envVars: {ONTAP_CLUSTER_URL: https://...}}
    CS->>DB: INSERT mcp_servers {syncStatus: pending}
    CS-->>User: 201 Created

    Note over CS,BF: 3. Sync to Bifrost (register + bind to VK)
    CS->>BF: POST /api/mcp/client<br/>{name: as-proj-p1-ontap, ...}
    BF-->>CS: {client_id: mcp-client-uuid}
    CS->>BF: PUT /api/virtual-keys/{vkId}<br/>{mcp_configs: [{mcp_client_id: mcp-client-uuid, allowed_tools: [...]}]}
    BF-->>CS: 200 OK

    Note over CS,K8S_MCP: 4. Materialize Runtime Credentials
    CS->>K8S_CRED: Read Secret "as-cred-cred-123"
    K8S_CRED-->>CS: {username, password, client_cert_pem, client_key_pem, ca_bundle_pem}
    CS->>K8S_MCP: Create Secret "as-mcp-ontap-123-credentials"<br/>{ONTAP_USERNAME, ONTAP_PASSWORD,<br/>client_cert_pem, client_key_pem, ca_bundle_pem}
    K8S_MCP-->>CS: Stored

    Note over CS,POD: 5. Launch MCP Pod
    CS->>POD: Create Deployment with:<br/>- Env: ONTAP_CLUSTER_URL (user-provided)<br/>- Env from Secret: ONTAP_USERNAME, ONTAP_PASSWORD<br/>- Files from Secret: /etc/ontap/client.crt, client.key, ca.pem
    POD->>POD: Health probe: GET :8000/health ✅
    CS->>DB: UPDATE syncStatus = synced
```

**credentialMapping Translation:**

```typescript
// From catalog definition:
credentialMapping: {
  expectedProvider: 'ontap',
  envFromKeys: {
    username: 'ONTAP_USERNAME',    // → Env var in pod
    password: 'ONTAP_PASSWORD',    // → Env var in pod
  },
  fileFromKeys: {
    client_cert_pem: { 
      mountPath: '/etc/ontap/client.crt',      // → File in pod
      envForPath: 'ONTAP_CLIENT_CERT_PATH',    // → Env var pointing to file
      mode: 0o400 
    },
    client_key_pem: { 
      mountPath: '/etc/ontap/client.key', 
      envForPath: 'ONTAP_CLIENT_KEY_PATH', 
      mode: 0o400 
    },
    ca_bundle_pem: { 
      mountPath: '/etc/ontap/ca.pem', 
      envForPath: 'ONTAP_CA_BUNDLE_PATH', 
      mode: 0o444 
    },
  },
}
```

**What MCPRuntimeManager does:**
1. Reads credential Secret: `as-cred-{credentialId}` from K8s
2. Creates per-server Secret: `as-mcp-ontap-123-credentials` with mapped keys
3. Injects into pod:
   - **Env vars** from `envFromKeys`: `ONTAP_USERNAME`, `ONTAP_PASSWORD`
   - **Files** from `fileFromKeys`: mounted at `/etc/ontap/client.crt`, etc.
   - **Env vars pointing to files**: `ONTAP_CLIENT_CERT_PATH=/etc/ontap/client.crt`
   - **User-provided env**: `ONTAP_CLUSTER_URL` (from MCP server config)

#### Phase 2: Runtime (config-service NOT in path)

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant MAF as agent-service-maf
    participant BF as Bifrost<br/>MCP Gateway
    participant POD as K8s Pod<br/>(ontap-mcp)
    participant ONTAP as ONTAP Cluster

    User->>MAF: "Show me all volumes on ONTAP"
    MAF->>MAF: Agent decides: call tool list_volumes
    MAF->>BF: POST /mcp<br/>Authorization: Bearer SA-token<br/>X-User-Token: Bearer user-JWT<br/>tool: list_volumes
    BF->>BF: Auth: Validate SA token ✅<br/>RBAC: Check VK mcp_configs ✅<br/>Tool: list_volumes in allowed_tools ✅
    BF->>POD: MCP stdio call: list_volumes
    POD->>POD: Read env:<br/>ONTAP_CLUSTER_URL<br/>ONTAP_USERNAME<br/>ONTAP_PASSWORD<br/>ONTAP_CLIENT_CERT_PATH
    POD->>ONTAP: GET /api/storage/volumes<br/>Auth: Basic (username/password)<br/>OR mTLS (client.crt + client.key)
    ONTAP-->>POD: [{name: vol1, size: 100GB, svm: svm1}, ...]
    POD-->>BF: MCP response
    BF-->>MAF: Tool result
    MAF->>MAF: Format as markdown table
    MAF-->>User: "Here are your ONTAP volumes:\n| Volume | Size | SVM |\n|---|---|---|\n| vol1 | 100GB | svm1 |"
```

**Key Points:**

| Aspect | Detail |
|--------|--------|
| **Credential storage** | K8s Secret `as-cred-{id}` (source of truth) |
| **Per-server secret** | K8s Secret `as-mcp-ontap-123-credentials` (materialized copy) |
| **Pod gets credentials** | Env vars + mounted files (never touches original credential secret) |
| **Runtime lookup** | Pod reads from its own environment (no K8s API calls) |
| **config-service role** | Setup only (not in runtime path) |
| **Security isolation** | Pod has scoped credentials, can't access other projects' secrets |

**Why two secrets?**
- **Original credential secret** (`as-cred-{id}`) — reusable across multiple MCP servers
- **Per-server secret** (`as-mcp-ontap-123-credentials`) — contains only what this pod needs, with env var names mapped per `credentialMapping`

This design allows:
- ✅ One credential used by multiple MCP servers
- ✅ Each pod gets scoped credentials (principle of least privilege)
- ✅ Credential rotation without pod restart (just update per-server secret)
- ✅ Different MCP templates with different `credentialMapping` schemas

---

### 10.6 Secret Storage Map

```mermaid
flowchart TD
    subgraph K8S["K8s Secrets"]
        VKT["as-proj-{id}-vk\nvirtual_key_token: bk-proj-xxx"]
        AZK["credential-{id}-secret\napi_key: sk-azure-xxx"]
        GHT["mcp-{name}-env\nGITHUB_TOKEN: ghp_xxx"]
    end

    subgraph BF["Bifrost keystore"]
        BVK["VK: bk-proj-xxx\n(validates LLM calls)"]
        BAZ["Provider key: sk-azure-xxx\n(calls Azure at runtime)"]
        BMCP["MCP client registry\ngithub · duckdb urls"]
    end

    subgraph DB["PostgreSQL"]
        PR["projects.metadata._gateway\nteamId · virtualKeyId"]
        CR["credentials\nmetadata only — NO secrets"]
        MR["mcp_servers\nurl · status · syncStatus\nNO auth secrets"]
    end

    VKT -.->|"MAF reads via config-service"| BVK
    AZK -.->|"pushed to Bifrost at model registration"| BAZ
    GHT -.->|"injected into MCP pod env"| BMCP

    style K8S fill:#dcfce7
    style BF fill:#dbeafe
    style DB fill:#fef9c3
```

---

### 10.7 Key Design Decisions

| Decision | What | Why |
|---|---|---|
| **Single gateway client** | All LLM calls through `llm_gateway.py` → Bifrost | Framework adapters never call Azure/Anthropic directly — one place for retry, auth, usage tracking |
| **Per-project VK** | Each project has `bk-proj-xxx` | Enforces model allowlist, rate limits, budget per project — MAF gets it via config-service, never reads K8s directly |
| **Per-agent MCP scoping** | `x-bf-mcp-include-tools` header per request | VK has all project MCP clients; header restricts to this agent's tools only |
| **Two-token MCP model** | SA-token (proves MAF identity) + X-User-Token (on-behalf-of user) | MCP server knows both who is calling (MAF) and on behalf of whom (user) |
| **Secrets never in DB** | PostgreSQL stores metadata only | VK token, Azure key, GitHub token all in K8s Secrets — DB leak never exposes credentials |
| **TTL cache on config-service** | 60s cache for agent/MCP/VK fetches | Avoids per-request round trips to config-service; invalidate on change |
