# ADR: Web Crawl Strategy (MCP-First)

## Status
Accepted (design phase only; no crawl implementation in this ADR iteration)

## Context
The platform now supports managed MCP-based web search providers. We need a path for crawl support that works with current agent-runtime tool orchestration and can later evolve into persistent, hierarchical web ingestion when needed.

## Decision
Adopt an MCP-first crawl strategy in near term, with connector-based ingestion as a future pivot when persistence and reuse requirements justify additional complexity.

## Options Considered

### Option A: Tavily crawl/map tools as runtime MCP
- Pros: fastest path, no new architecture, immediate agent-time crawl capability.
- Cons: runtime-only results, higher token/tool-call cost for repeated use, weaker long-lived corpus management.

### Option B: Dedicated crawl MCP server (e.g., crawl4ai-style) as runtime MCP
- Pros: deeper crawl control (depth, domain/path filters, traversal policy), still fits existing MCP runtime.
- Cons: additional image/operator overhead, quality and stability vary by provider implementation.

### Option C: Connector + KB ingestion pipeline (future)
- Pros: persistent, hierarchical web corpus; reusable across agents/sessions; better governance and indexing control.
- Cons: larger product surface (connector UX, scheduler, ingestion lifecycle, freshness policies), slower to ship.

## Rationale
MCP-first aligns with current architecture and minimizes time-to-value. It enables immediate crawl experimentation while preserving optionality for a connector-backed persistence model later.

## Guardrails (for MCP crawl)
- Enforce strict bounds on timeout, max pages/results, and retries.
- Support optional domain allowlists and path scoping.
- Keep crawl tools opt-in via explicit allowlists.
- Provide clear user-facing errors for unreachable endpoints/timeouts.

## Rollout
1. Keep crawl as design-only in this phase.
2. Implement provider search changes first (Tavily rename + SearxNG search).
3. If runtime crawl is enabled later, gate with provider flags and conservative defaults.

## Migration Criteria to Connector-First
Move from MCP runtime crawl to connector ingestion when one or more are true:
- Web corpus is reused across many agents or sessions.
- Freshness SLA requires scheduled recrawls.
- Data volume/cost from repeated runtime crawling is too high.
- Governance requires auditable ingestion lifecycle and storage policies.

## Consequences
- Short-term: faster delivery with MCP runtime consistency.
- Mid-term: potential repeated crawl cost if reuse is high.
- Long-term: clear migration path to connector-backed persistent web corpus.
