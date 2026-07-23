# MAF migration — document index

Documents tracking the migration of the `agent-service-maf` codebase into AgentStudio and the broader replacement of the legacy `src/nemo/agent-service/`.

## Reading order

| # | File | Purpose | Status |
|---|---|---|---|
| 00 | `00-migration-analysis.md` | Comprehensive audit: legacy vs. MAF, gap analysis, risk assessment, implementation status across §5.1–§5.9 plus the identity-propagation work. **Start here.** | ⏳ Pending (not yet on this branch) |
| 01 | `01-execution-plan.md` | Per-§5-lock-in implementation tasks inside `agent-service-maf` (schemas, adapter, routes, tests). Most items already done — see audit notes inline. | ⏳ Pending |
| 02 | `02-identity-propagation-plan.md` | End-to-end identity flow: `IdentityContext`, gateway-injected `X-User-ID` / `X-Project-ID` / `X-User-Email` / `X-User-Name` headers, two-token model (service token on `Authorization`, user JWT on `X-User-Token`) across MCP / Bifrost / KB. Implemented. | ⏳ Pending |
| 03 | `03-output-schema-validation-plan.md` | JSON Schema → Pydantic validation for `parsedOutput`. Bridges agent-level `output_schema` and per-request `context.outputSchema` with a parse-only path when `response_format: "json_object"` is set without a schema. Not yet implemented; ~2 dev-days. | ⏳ Pending |
| 04 | `04-config-bridge-schema-comparison.md` | Field-by-field comparison between legacy `config-service` entity model (`Agent`, `AgentTeam`) and MAF team JSON schema (`SKAgentDefinition`, `OrchestrationConfig`). Reference for the eventual config-service bridge work. | ⏳ Pending |
| 05 | `05-into-agentstudio-migration-plan.md` | Directory move of `agent-service-maf` from `agent-studio/server/apps/agent-service-maf/` to `src/nemo/agent-service-maf/`. Three PRs: code move → CI wiring → Helm chart. | ✅ Present |

## Status legend

- ✅ **Present** — committed and reviewable in this branch.
- ⏳ **Pending** — drafted previously but not yet committed to this branch; to be added back in a follow-up commit. Cross-references in other docs to these filenames assume they will land before the migration is considered complete.

## Cross-references

- The MAF service itself lives at `src/nemo/agent-service-maf/`.
- The legacy `agent-service` it replaces lives at `src/nemo/agent-service/`.
- During the transition both coexist; the Helm chart for MAF is `enabled: false` by default and is flipped per environment when ready.
- Service-internal docs for MAF (design notes, OpenAPI spec, etc.) live at `src/nemo/agent-service-maf/docs/` — those are scoped to the service, not the migration.
- The directory-move plan (`05-into-agentstudio-migration-plan.md`) supersedes any earlier references to the standalone `agent-studio` monorepo location.
