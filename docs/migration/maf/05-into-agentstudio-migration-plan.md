# Migration Plan — Move `agent-service-maf` into AgentStudio repo

**Goal.** Relocate the `agent-service-maf` codebase from `/Users/ak57591/NetApp-CodeBase/agent-studio/server/apps/agent-service-maf/` into the `AgentStudio` repository at `/Users/ak57591/NetApp-CodeBase/AgentStudio/`. The legacy `src/nemo/agent-service/` stays in place during the transition so both can be deployed and switched per-project via the API gateway.

**Source root:** `/Users/ak57591/NetApp-CodeBase/agent-studio/server/apps/agent-service-maf/` (call it `SRC`)
**Target root:** `/Users/ak57591/NetApp-CodeBase/AgentStudio/src/nemo/agent-service-maf/` (call it `DST`)

The naming pattern mirrors every other nemo service in the host repo — `src/nemo/{service-name}/` — and the new service sits alongside the legacy `src/nemo/agent-service/` until cutover.

---

## 1. Scope

**In scope (one PR or coordinated PR train):**

1. Copy the MAF source, tests, configs, deploy artifacts, docs, build glue.
2. Add a new Helm chart `deployments/helm/nemo/charts/agent-service-maf/` so the service can be deployed alongside the legacy chart.
3. Wire MAF into the existing CI workflows (`build-common.yml`, `main.yml`, `deploy.yml`, `wiz-image-scan.yml`).
4. Update any cross-file references inside MAF's docs/comments that point to the old standalone-repo paths.
5. Keep the existing top-level docs (`migration-analysis-agent-service-to-maf.md`, `maf-*plan.md`) — they're already in AgentStudio's workspace.

**Out of scope (separate work items):**

- API gateway cutover (`apigateway-service/main.go:175` `AGENT_SERVICE_URL` — switch happens after MAF is deployable in AgentStudio's stack).
- Decommissioning the legacy `src/nemo/agent-service/` — keep until per-project cutover is green.
- Schema-bridge / config-service integration (covered in `maf-config-bridge-schema-comparison.md`).
- Identity-propagation, Option-B output-schema, or any other open-§7 work — those are independent plans that ship on the moved code, not as part of the move.

---

## 2. Target location — `src/nemo/agent-service-maf/`

| Concern | Decision |
|---|---|
| Coexist with legacy | ✅ Yes. Legacy stays at `src/nemo/agent-service/`; new lives at `src/nemo/agent-service-maf/`. Both built, both deployable. |
| Rename legacy to `agent-service-legacy` | ❌ No, not now. Renaming legacy is a separate breaking change; do after cutover, not during. |
| Replace legacy directly | ❌ No. Adds risk; can't roll back per-project. |
| Helm chart | New `deployments/helm/nemo/charts/agent-service-maf/`. Mirror `agent-service/` chart shape (Chart.yaml, templates/, values.yaml). |
| Docker image name | `nemo/agent-service-maf:{tag}` (mirrors `nemo/agent-service:{tag}`). |
| Service port | 8000 in-container (same as legacy). k8s Service name `agent-service-maf` so DNS doesn't collide with `agent-service`. |
| Env var for downstream | New `AGENT_SERVICE_MAF_URL` in `apigateway-service`. Cutover is then a config flip from `AGENT_SERVICE_URL` → `AGENT_SERVICE_MAF_URL` per project (or fleet-wide). |

---

## 3. File inventory — what to copy, transform, exclude

### 3.1 Copy verbatim (preserves content; no edits beyond path-references in §4)

| Source path (relative to `SRC`) | Target path (relative to `DST`) | Notes |
|---|---|---|
| `src/` | `src/` | Python source — `agent_framework/` package and everything under it. Largest piece. |
| `tests/` | `tests/` | Unit / integration / e2e tests. ~ all of them. |
| `configs/` | `configs/` | Example team configs (`team/*.json`, `agent_config.reference.json`). |
| `configs/team/` | `configs/team/` | Sample team JSONs (`single_agent_mcp.json`, `handoff_support.json`, etc.). |
| `bruno/` | `bruno/` | Bruno API test collection (referenced in `maf-output-schema-validation-plan.md` §I2). |
| `data/` | `data/` | Test fixtures (CSV / JSON / Markdown for tool inputs). |
| `deploy/` | `deploy/` | Contains the production `Dockerfile`. **Note**: `Dockerfile.dockerignore` should be renamed to `.dockerignore` inside `deploy/` (or moved to root — see §3.3). |
| `docker/` | `docker/` | Mock services (`mock-llm`, `mock-mcp`) for Bruno + integration tests. |
| `scripts/` | `scripts/` | Demo/test bash scripts and `generate_openapi.py`. |
| `tools/` | `tools/` | Codegen / openapi tools. |
| `docs/` | `docs/` | MAF-internal design docs (a2a, mcp, etc.). |
| `Makefile` | `Makefile` | Build / test / lint targets. |
| `pyproject.toml` | `pyproject.toml` | Python project + tool config. |
| `uv.lock` | `uv.lock` | Locked deps. Keep — reproducible builds. |
| `project.json` | `project.json` | Nx-style project manifest (if AgentStudio uses Nx; otherwise harmless metadata). |
| `README-DEVELOPMENT.md` | `README-DEVELOPMENT.md` | Dev guide. |
| `README-REQUIREMENTS.md` | `README-REQUIREMENTS.md` | Schema requirements ref. |
| `maf-async-invoke-design.md` | `docs/design/async-invoke.md` | Move into `docs/design/` for discoverability. |
| `.env.example` | `.env.example` | Env var template. |
| `.dockerignore` | `.dockerignore` | Top-level docker ignore. |
| `.gitignore` | `.gitignore` | **Merge** with AgentStudio's root `.gitignore` if there's overlap; otherwise keep as a sub-tree `.gitignore`. |

### 3.2 Exclude — do NOT copy

These are local-only and should be regenerated, or are stale artifacts.

| Source path | Why excluded |
|---|---|
| `.venv/` | Virtual environment — recreated by `uv sync` / `pip install`. |
| `.pytest_cache/` | Test runner cache. |
| `.ruff_cache/` | Lint cache. |
| `.mypy_cache/` | Type checker cache. |
| `.coverage` | Coverage data file. |
| `App_Logs/` | Runtime log output. |
| `Trace_Logs/` | Runtime trace output. |
| `e2e-docker-logs.txt` | One-shot test log. |
| `.DS_Store` (every dir) | macOS Finder noise. |
| `docs/spec/.DS_Store` | Same. |
| `**/__pycache__/` | Python bytecode cache. |

Add a `find` + `xargs` purge step in the migration script to strip these before committing — see §6.

### 3.3 Transform (path-reference updates)

These need light edits during/after the copy. **Find-replace is mechanical; no semantic changes.**

| File(s) | What to update |
|---|---|
| `README-DEVELOPMENT.md` | References to `agent-studio/server/apps/agent-service-maf/...` paths → `src/nemo/agent-service-maf/...` (or relative paths). Update the "where this lives" section. |
| `README-REQUIREMENTS.md` | Same path updates. |
| `docs/**/*.md` | Any path references to the old standalone-repo layout. |
| `Makefile` | If any targets reference paths outside the directory (e.g., parent-repo paths), make them relative. |
| `pyproject.toml` | If `[tool.uv.sources]` or similar references the parent monorepo, remove. Check `[tool.pytest.ini_options]` for any absolute paths. |
| `.dockerignore` (in `deploy/Dockerfile.dockerignore`) | Rename to `.dockerignore` in `deploy/` and confirm patterns are relative to build context. |
| Inline docstrings referencing legacy paths | Many MAF files cite `src/nemo/agent-service/src/main.py:NNN` — these stay (they reference the legacy repo, which now lives in the *same* repo). No edit needed; they remain valid. |
| Inline docstrings citing `/Users/.../agent-studio/server/apps/...` (absolute path) | Update to relative or drop. |

Recommended sweep command after copy:

```bash
# From the new DST root
grep -rIn "agent-studio/server/apps/agent-service-maf" . \
  --include='*.py' --include='*.md' --include='*.toml' --include='*.json' \
  --include='Makefile' --include='*.sh' --include='*.yaml' --include='*.yml'
```

Each hit needs review. Most should be replaced with `src/nemo/agent-service-maf/...` or just made relative.

---

## 4. Helm chart — new `agent-service-maf/`

Add `deployments/helm/nemo/charts/agent-service-maf/` mirroring `agent-service/`. New files:

```
deployments/helm/nemo/charts/agent-service-maf/
├── Chart.yaml
├── values.yaml
├── templates/
│   ├── _helpers.tpl
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── hpa.yaml
│   ├── networkpolicy.yaml
│   └── servicemonitor.yaml
```

### 4.1 Differences from the legacy `agent-service/` chart

| Concern | Legacy chart | MAF chart |
|---|---|---|
| Image name | `nemo/agent-service` | `nemo/agent-service-maf` |
| k8s Service name | `agent-service` | `agent-service-maf` |
| Container port | 8000 | 8000 (same) |
| Env vars consumed | `CONFIG_SERVICE_URL`, `KB_RETRIEVAL_SERVICE_URL`, `ANALYTICS_ENGINE_URL`, `LITELLM_PROXY_URL`, `REDIS_URL`, `POSTGRES_URL`, Phoenix vars | `AGENT_TEAMS_DIR`, `AGENT_DEFAULT_TEAM`, `AGENT_INTERFACE__AUTH__*`, `AGENT_GATEWAY__URL` (Bifrost), `AGENT_GATEWAY__API_KEY`, `AGENT_MEMORY__REDIS_URL`, `AGENT_TASKS__REDIS_URL`. **Different env scheme.** |
| Liveness probe | `/health` | `/health` (same) |
| Readiness probe | `/health` (legacy doesn't expose `/ready` separately) | `/ready` (per §5.8 of the analysis doc) |
| NetworkPolicy egress | config-service, kb-retrieval-service, analytics-engine, litellm-proxy, redis, postgres, phoenix | Bifrost, redis, MCP servers (per-project URLs). Smaller egress set. |
| ServiceMonitor | scrapes legacy metrics endpoint | scrapes MAF's Prometheus metrics (verify exposure path) |
| Resources | per legacy values | start with same; tune after benchmarking |
| HPA | per legacy | same shape; same min/max as starting point |

### 4.2 `values.yaml` skeleton

```yaml
image:
  repository: nemo/agent-service-maf
  tag: ""           # set per release
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 8000

resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 2000m
    memory: 2Gi

replicas: 2
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

env:
  AGENT_TEAMS_DIR: /etc/agent-teams
  AGENT_INTERFACE__AUTH__ENABLED: "true"
  AGENT_INTERFACE__AUTH__SCHEME: "gateway_identity"   # per identity-propagation plan
  AGENT_GATEWAY__URL: "http://bifrost.nemo.svc.cluster.local:4000/v1"
  AGENT_MEMORY__STORAGE_BACKEND: "redis"
  AGENT_MEMORY__REDIS_URL: "redis://redis-master.nemo.svc.cluster.local:6379/0"
  AGENT_TASKS__BACKEND: "redis"
  AGENT_TASKS__REDIS_URL: "redis://redis-master.nemo.svc.cluster.local:6379/1"

envFromSecret:
  - name: AGENT_GATEWAY__API_KEY
    secretName: bifrost-credentials
    key: api-key
  - name: AGENT_MCP_SERVICE_TOKEN          # per identity-propagation two-token model
    secretName: mcp-service-tokens
    key: service-token
  - name: AGENT_KB_SERVICE_TOKEN
    secretName: kb-service-tokens
    key: service-token

teamConfigsConfigMap:
  enabled: true
  name: agent-service-maf-teams           # mounted at AGENT_TEAMS_DIR
```

### 4.3 Top-level chart wiring

Add `agent-service-maf` as a sub-chart in `deployments/helm/nemo/Chart.yaml`:

```yaml
dependencies:
  - name: agent-service
    version: 1.0.0
  - name: agent-service-maf            # ← new
    version: 0.1.0
  - name: analytics-engine
    version: 1.0.0
  # ...
```

Optionally gate via `values.yaml`:

```yaml
agent-service:
  enabled: true
agent-service-maf:
  enabled: false                       # default off; flip to true per environment
```

Per-env values override decides whether MAF is deployed. Legacy stays at `enabled: true` until cutover complete.

### 4.4 Don't forget the helmignore + namespace

- Copy `analytics-engine/templates/_helpers.tpl` as a starting template; rename refs to `agent-service-maf`.
- Reuse the same k8s namespace as the rest of nemo (`nemo` by default).

---

## 5. CI / CD wiring

The host repo has six workflow files in `.github/workflows/`. MAF needs to plug into them.

### 5.1 `build-common.yml` — shared build job

Add a job stanza for `agent-service-maf`:

```yaml
build-agent-service-maf:
  if: needs.detect-changes.outputs.agent-service-maf == 'true'
  uses: ./.github/workflows/build-common.yml
  with:
    service: agent-service-maf
    context: src/nemo/agent-service-maf
    dockerfile: src/nemo/agent-service-maf/deploy/Dockerfile
    image: nemo/agent-service-maf
```

The `detect-changes` job (or equivalent path-filter mechanism in `main.yml`) needs `agent-service-maf: 'src/nemo/agent-service-maf/**'` added to its filter list.

### 5.2 `main.yml` — main CI orchestration

Add `agent-service-maf` to:
- The path filter list (so changes in `src/nemo/agent-service-maf/**` trigger build + test).
- The matrix or service list of build jobs.
- The chart-build / chart-package step (so the new Helm chart is built and tagged with each release).

### 5.3 `deploy.yml` — deployment

Add MAF to the deployment matrix. Behind a feature-flag env at first — most environments start with `agent-service-maf.enabled: false`.

### 5.4 `wiz-image-scan.yml` — security scanning

Add `nemo/agent-service-maf` to the list of images scanned per release. Same Wiz policy as other Python services.

### 5.5 MAF-internal CI (drop or merge)

The standalone `agent-service-maf` repo had its own `.github/workflows/` for ci / cd. **Do not copy these into AgentStudio.** AgentStudio's workflows already handle build / test / scan / release. Bring across only what's missing:

- Any MAF-specific pytest invocation: fold into `build-common.yml`'s test step for `agent-service-maf`.
- Bruno test job: new job in `main.yml` (per `maf-output-schema-validation-plan.md` §I5).
- OpenAPI drift check: new step in `main.yml` for the `agent-service-maf` service.

---

## 6. Sequencing — recommended PR plan

Three PRs in order. Each leaves AgentStudio in a working state.

### PR 1 — Code move only (no CI / Helm changes)

```
git mv agent-studio/server/apps/agent-service-maf  AgentStudio/src/nemo/agent-service-maf
# (after sanitizing — see migration script below)
```

Actually a `git mv` won't cross repositories. Practical approach:

```bash
# In a working copy of AgentStudio
SRC=/path/to/agent-studio/server/apps/agent-service-maf
DST=src/nemo/agent-service-maf

mkdir -p "$DST"
rsync -a \
  --exclude='.venv/' \
  --exclude='.pytest_cache/' \
  --exclude='.ruff_cache/' \
  --exclude='.mypy_cache/' \
  --exclude='.coverage' \
  --exclude='App_Logs/' \
  --exclude='Trace_Logs/' \
  --exclude='e2e-docker-logs.txt' \
  --exclude='**/__pycache__/' \
  --exclude='**/.DS_Store' \
  "$SRC/" "$DST/"

# Rename docs that landed at the top of MAF
mkdir -p "$DST/docs/design"
git mv "$DST/maf-async-invoke-design.md" "$DST/docs/design/async-invoke.md"

# Rename Dockerfile.dockerignore → .dockerignore inside deploy/
git mv "$DST/deploy/Dockerfile.dockerignore" "$DST/deploy/.dockerignore"

# Sweep absolute path references
grep -rIn "agent-studio/server/apps/agent-service-maf" "$DST" \
  --include='*.py' --include='*.md' --include='*.toml' --include='*.json' \
  --include='Makefile' --include='*.sh' --include='*.yaml' --include='*.yml' \
  | review-and-fix-each

git add "$DST"
git commit -m "feat(maf): move agent-service-maf into src/nemo/agent-service-maf"
```

This PR: code only. Helm + CI untouched. The new directory exists but isn't built or deployed yet. CI passes because nothing in the existing pipelines touches the new path.

**Also in PR 1 (small additions, per locked §9 decisions):**

```bash
# Relocate top-level migration docs
mkdir -p docs/migration/maf
git mv migration-analysis-agent-service-to-maf.md             docs/migration/maf/00-migration-analysis.md
git mv maf-migration-execution-plan.md                        docs/migration/maf/01-execution-plan.md
git mv maf-identity-propagation-plan.md                       docs/migration/maf/02-identity-propagation-plan.md
git mv maf-output-schema-validation-plan.md                   docs/migration/maf/03-output-schema-validation-plan.md
git mv maf-config-bridge-schema-comparison.md                 docs/migration/maf/04-config-bridge-schema-comparison.md
git mv maf-into-agentstudio-migration-plan.md                 docs/migration/maf/05-into-agentstudio-migration-plan.md

# Author an index file
cat > docs/migration/maf/README.md <<'EOF'
# MAF migration — document index

Reading order:

| File | Purpose |
|---|---|
| `00-migration-analysis.md` | Comprehensive audit: legacy vs. MAF, gap analysis, risk assessment, current implementation status. **Start here.** |
| `01-execution-plan.md` | Per-§5-lock-in tasks inside `agent-service-maf` (schemas, adapter, routes, tests). Most of these are already done — see audit notes inline. |
| `02-identity-propagation-plan.md` | End-to-end identity flow: `IdentityContext`, gateway-injected headers, two-token model across MCP / Bifrost / KB. Implemented. |
| `03-output-schema-validation-plan.md` | JSON Schema → Pydantic validation for `parsedOutput`. Not yet implemented; ~2 dev-days. |
| `04-config-bridge-schema-comparison.md` | Field-by-field comparison between legacy `config-service` entity model and MAF team JSON. Reference for the eventual config-service bridge. |
| `05-into-agentstudio-migration-plan.md` | This directory move (file you came from). |
EOF
```

**Add Makefile proxy targets** to AgentStudio's root `Makefile` (if it has one — otherwise create or skip and document):

```make
# ──────────────────────────────────────────────────────────
# agent-service-maf proxy targets — delegate to service-local Makefile
# ──────────────────────────────────────────────────────────

.PHONY: agent-service-maf-build agent-service-maf-test agent-service-maf-lint agent-service-maf-bruno

agent-service-maf-build:
	$(MAKE) -C src/nemo/agent-service-maf build

agent-service-maf-test:
	$(MAKE) -C src/nemo/agent-service-maf test

agent-service-maf-lint:
	$(MAKE) -C src/nemo/agent-service-maf lint

agent-service-maf-bruno:
	$(MAKE) -C src/nemo/agent-service-maf bruno-test
```

These give the AgentStudio-root dev surface the convenience of running MAF commands without `cd`'ing into the service directory, while the actual logic stays in `src/nemo/agent-service-maf/Makefile` (single source of truth).

### PR 2 — CI workflow integration

Add MAF to:
- `build-common.yml` build job.
- `main.yml` path filter + matrix.
- `wiz-image-scan.yml` image list.
- New OpenAPI drift check job (per `maf-output-schema-validation-plan.md` §G5).
- New Bruno test job (per same plan §I5) — optional, can defer.

After this PR: pushing changes to `src/nemo/agent-service-maf/**` triggers build, test, image push to the registry. **MAF is still not deployed** — Helm chart doesn't exist yet.

### PR 3 — Helm chart + deploy wiring

Add `deployments/helm/nemo/charts/agent-service-maf/` (Chart.yaml, templates, values.yaml). Wire into root `Chart.yaml` as a sub-chart with `enabled: false` by default. Add `agent-service-maf` to `deploy.yml`'s deployment list (behind the same enable flag).

After this PR: in environments where you set `agent-service-maf.enabled: true`, the service deploys. By default it's off, so production is unchanged.

### Post-PRs — per-environment cutover

Independently of these PRs, switch `agent-service-maf.enabled: true` in the env-specific values file for one environment at a time. Then optionally flip `AGENT_SERVICE_URL` → `AGENT_SERVICE_MAF_URL` in `apigateway-service` config so traffic actually routes there. That's the "go live" toggle, separate from the move.

---

## 7. Migration script (one-shot, run from AgentStudio root)

```bash
#!/usr/bin/env bash
set -euo pipefail

SRC="${1:?usage: $0 /path/to/agent-studio/server/apps/agent-service-maf}"
DST="src/nemo/agent-service-maf"

if [ -d "$DST" ]; then
  echo "ERROR: $DST already exists. Aborting."
  exit 1
fi

mkdir -p "$DST"

# Copy with exclusions
rsync -a \
  --exclude='.venv/' \
  --exclude='.pytest_cache/' \
  --exclude='.ruff_cache/' \
  --exclude='.mypy_cache/' \
  --exclude='.coverage' \
  --exclude='App_Logs/' \
  --exclude='Trace_Logs/' \
  --exclude='e2e-docker-logs.txt' \
  --exclude='**/__pycache__/' \
  --exclude='**/.DS_Store' \
  "$SRC/" "$DST/"

# Rename the design doc into docs/
mkdir -p "$DST/docs/design"
if [ -f "$DST/maf-async-invoke-design.md" ]; then
  mv "$DST/maf-async-invoke-design.md" "$DST/docs/design/async-invoke.md"
fi

# Rename Dockerfile.dockerignore → .dockerignore for clarity
if [ -f "$DST/deploy/Dockerfile.dockerignore" ] && [ ! -f "$DST/deploy/.dockerignore" ]; then
  mv "$DST/deploy/Dockerfile.dockerignore" "$DST/deploy/.dockerignore"
fi

# Report any absolute paths that still reference the old location
echo
echo "=== Absolute-path references to review (manual edits needed) ==="
grep -rIn "agent-studio/server/apps/agent-service-maf" "$DST" \
  --include='*.py' --include='*.md' --include='*.toml' --include='*.json' \
  --include='Makefile' --include='*.sh' --include='*.yaml' --include='*.yml' \
  || echo "(none found)"

# Suggest staging
echo
echo "Done. Review the references above, run tests locally, then:"
echo "  git add $DST"
echo "  git commit -m 'feat(maf): move agent-service-maf into src/nemo/agent-service-maf'"
```

Save this as `scripts/migrate-maf-into-tree.sh` for repeatability.

---

## 8. Verification checklist — after PR 1

| Check | How |
|---|---|
| Directory exists at `src/nemo/agent-service-maf/` | `ls src/nemo/agent-service-maf/` |
| No `.venv`, caches, logs, or `.DS_Store` checked in | `git ls-files src/nemo/agent-service-maf/ \| grep -E '(\.venv\|__pycache__\|_cache\|\.coverage\|App_Logs\|\.DS_Store)$'` returns nothing |
| Python deps install cleanly | `cd src/nemo/agent-service-maf && uv sync` |
| Unit tests pass | `cd src/nemo/agent-service-maf && uv run pytest tests/unit/` |
| Integration tests pass | `cd src/nemo/agent-service-maf && uv run pytest tests/integration/` |
| Dockerfile builds | `docker build -f src/nemo/agent-service-maf/deploy/Dockerfile src/nemo/agent-service-maf/` |
| No absolute paths to old monorepo | `grep -r "agent-studio/server/apps" src/nemo/agent-service-maf/` returns nothing |
| OpenAPI export reproducible | `cd src/nemo/agent-service-maf && make regen-openapi` (per the Option-B plan's H1 step) |
| Bruno collection openable | Open `src/nemo/agent-service-maf/bruno/` in Bruno desktop UI |
| Legacy still works | `make build` (or equivalent) for `agent-service` succeeds unchanged |
| Migration docs relocated | `ls docs/migration/maf/` shows the six relocated files + README.md; nothing `maf-*.md` left at AgentStudio root |
| Root Makefile proxies wired | `make agent-service-maf-test` from AgentStudio root delegates to the service Makefile and succeeds |

### After PR 2 (CI integration)

| Check | How |
|---|---|
| Push to `src/nemo/agent-service-maf/**` triggers build | Push a doc-only change, watch GitHub Actions |
| Image published to registry | After merge, look for `nemo/agent-service-maf:{sha}` in the registry |
| Test results uploaded | JUnit / coverage artifacts visible on the PR |
| Wiz image scan runs | Scan job appears in workflow output |

### After PR 3 (Helm)

| Check | How |
|---|---|
| Chart packages | `helm package deployments/helm/nemo/charts/agent-service-maf/` succeeds |
| Renders cleanly | `helm template ./deployments/helm/nemo --set agent-service-maf.enabled=true` produces valid k8s manifests |
| Deploys in dev | `helm upgrade --install nemo ./deployments/helm/nemo --set agent-service-maf.enabled=true` works in a dev cluster |
| Pod readiness | `/ready` returns 200 after pod starts |
| Legacy chart unchanged | Comparing pre/post diff on `deployments/helm/nemo/charts/agent-service/` shows zero changes |

---

## 9. Decisions (locked)

1. **`uv.lock`** — ✅ **Keep.** Reproducible builds. If AgentStudio's root tooling needs reconciliation later, do it after the move; lock stays under `src/nemo/agent-service-maf/`.
2. **`docs/spec/` directory** — ✅ **Keep in `src/nemo/agent-service-maf/docs/spec/`.** Service-local; cross-reference from top-level migration docs as needed.
3. **`bruno/` and `tools/`** — ✅ **Service-local.** Stay at `src/nemo/agent-service-maf/bruno/` and `src/nemo/agent-service-maf/tools/`. They travel with the service so a developer checking out only this subtree has everything to run + extend the test suite.
4. **`Makefile`** — ✅ **Service-local `Makefile` stays.** AgentStudio root gets `make agent-service-maf-build` and `make agent-service-maf-test` **proxy targets** that delegate to `src/nemo/agent-service-maf/Makefile`. Pattern: the proxy targets are one-liners (`$(MAKE) -C src/nemo/agent-service-maf build`) so the dev surface stays in the service directory.
5. **Top-level migration docs** — ✅ **Move into `docs/migration/maf/`** as part of PR 1. Six files relocated:

   ```
   AgentStudio/migration-analysis-agent-service-to-maf.md
   AgentStudio/maf-migration-execution-plan.md
   AgentStudio/maf-identity-propagation-plan.md
   AgentStudio/maf-output-schema-validation-plan.md
   AgentStudio/maf-config-bridge-schema-comparison.md
   AgentStudio/maf-into-agentstudio-migration-plan.md          ← this file
                                ↓
   AgentStudio/docs/migration/maf/
                                ↓
   docs/migration/maf/00-migration-analysis.md
   docs/migration/maf/01-execution-plan.md
   docs/migration/maf/02-identity-propagation-plan.md
   docs/migration/maf/03-output-schema-validation-plan.md
   docs/migration/maf/04-config-bridge-schema-comparison.md
   docs/migration/maf/05-into-agentstudio-migration-plan.md
   ```

   Numeric prefixes give a natural reading order: analysis → execution plan → propagation → schema validation → bridge → directory move. Plus an `docs/migration/maf/README.md` index file with one-line summaries of each.

---

## 10. Acceptance — definition of done

The migration is complete when:

1. ✅ `src/nemo/agent-service-maf/` exists in AgentStudio with the source, tests, configs, deploy, scripts, tools, docs, Makefile, pyproject, uv.lock — minus caches/venvs/logs/.DS_Store.
2. ✅ No absolute references to `/Users/.../agent-studio/server/apps/agent-service-maf/` anywhere in the moved tree (use `grep -r "agent-studio/server/apps"` to verify).
3. ✅ The original `agent-service-maf` repo is archived or the source location is deprecated — single source of truth is AgentStudio.
4. ✅ Local dev loop works: `cd src/nemo/agent-service-maf && uv sync && uv run pytest tests/unit/` passes.
5. ✅ Docker image builds via the AgentStudio CI workflows and gets tagged `nemo/agent-service-maf:{tag}`.
6. ✅ Helm chart at `deployments/helm/nemo/charts/agent-service-maf/` packages and renders. Default-off so production deploys are unchanged.
7. ✅ Wiz image scan runs against the new image.
8. ✅ Legacy `src/nemo/agent-service/` build/deploy is untouched and continues to ship to existing environments.
9. ✅ Per-environment cutover toggle (`agent-service-maf.enabled: true`) deploys the new service alongside the legacy one in a dev cluster, with both reachable on their own k8s Service names.
10. ✅ All six top-level migration docs relocated into `docs/migration/maf/` with numeric prefixes (`00-` through `05-`) and a `README.md` index. Nothing matching `*maf*.md` or `migration-analysis*.md` left floating at AgentStudio root.
11. ✅ AgentStudio root `Makefile` exposes `agent-service-maf-{build,test,lint,bruno}` proxy targets that delegate to `src/nemo/agent-service-maf/Makefile`.

Out-of-DoD (separate plans tracked elsewhere):

- API gateway cutover (`AGENT_SERVICE_URL` → MAF) — `migration-analysis-agent-service-to-maf.md` §9 Phase 2.
- Frontend / workflow-engine consumer migrations — same.
- Config-service bridge — `maf-config-bridge-schema-comparison.md`.
- Identity propagation, Option-B output schema — already implemented in MAF code; ride along on the move.

---

## 11. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Hidden absolute path references in code break runtime | ⚠️ Possible | 🟡 Medium | Pre-commit grep (§3.3 sweep); CI tests catch most. |
| 2 | `uv.lock` drift with the rest of AgentStudio's Python tooling | 🟢 Low | 🟢 Low | Keep MAF's lock isolated under `src/nemo/agent-service-maf/`; don't try to unify at the root. |
| 3 | Helm chart name collision with existing `agent-service` | 🟢 Very low | 🟡 Medium | Distinct names (`agent-service` vs `agent-service-maf`) at every level — k8s Service, image, chart. Verified the directory structure under `deployments/helm/nemo/charts/` accepts this. |
| 4 | CI workflow path-filter regression breaks legacy builds | ⚠️ Possible | 🔴 High | PR 2 adds path-filter for MAF; verify legacy filter remains untouched. CI smoke run on the PR before merge. |
| 5 | Loss of MAF's git history (it's not an Operator-friendly merge) | ✅ Will happen | 🟢 Low | Original history stays in the agent-studio standalone repo; AgentStudio gets a single "MAF moved in" commit. Reference the standalone repo URL in the move commit for traceability. If full history matters, use `git subtree add` or `git filter-repo` (more complex). Recommend: don't preserve history; it's not worth the friction. |
| 6 | Image registry name collision | 🟢 Low | 🟡 Medium | `nemo/agent-service-maf` is distinct from `nemo/agent-service`. Verify the registry namespace allows both. |
| 7 | NetworkPolicy egress allowlist gaps in new chart | ⚠️ Possible | 🟡 Medium | Start with the existing `analytics-mcp-server/` chart's NetworkPolicy as a template; add MAF-specific egress (Bifrost, Redis, MCP server URLs). Test in dev cluster. |
| 8 | Bruno tests depend on a mock LLM that only runs in dev | 🟢 Low | 🟢 Low | Per `maf-output-schema-validation-plan.md` §I4, the mock-llm sidecar is included; it's part of the move. |

---

## 12. After the move — quick start for a new developer

This is the README content the moved service should have, in `README-DEVELOPMENT.md`'s "Quick start" section. Either keep MAF's existing version (it's good), or extract the essentials below into AgentStudio's top-level `CONTRIBUTING.md` as a pointer:

```bash
# From AgentStudio root
cd src/nemo/agent-service-maf

# 1. Install Python deps (uv is the package manager)
uv sync

# 2. Run unit tests
uv run pytest tests/unit/

# 3. Run the service locally (talks to dev Bifrost + dev Redis)
cp .env.example .env       # then edit
uv run agent-server

# 4. Hit the health endpoint
curl http://localhost:8000/health

# 5. Run a sample team
export AGENT_TEAMS_DIR=$PWD/configs/team
export AGENT_DEFAULT_TEAM=single_agent_mcp
uv run agent-server

# 6. Bruno-driven API tests (requires Docker)
make bruno-test
```

---

## TL;DR

- **One directory move:** `agent-studio/server/apps/agent-service-maf/` → `src/nemo/agent-service-maf/`.
- **Three PRs:** code move → CI wiring → Helm chart. Each leaves the repo in a working state.
- **Don't touch legacy.** `src/nemo/agent-service/` stays in place until per-project cutover is complete.
- **New Helm chart `agent-service-maf`** deploys alongside legacy `agent-service` with a feature flag default-off.
- **No history preservation** — accept a single "MAF moved in" commit. Original repo URL goes in the commit message.
- **Verification is mechanical:** caches/venvs excluded, no absolute paths, unit tests green, Dockerfile builds, Helm renders.
