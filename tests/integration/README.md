# API Integration tests with pytest and allure for AgentStudio

Local-only API tests.

> **What each suite validates** (user-flow coverage) lives in [integration-test-coverage.md](integration-test-coverage.md). This README is the operational guide: how to set up, run, and maintain the harness.

## Setup

**Prerequisites:** local AgentStudio is up and reachable.

| | URL |
|---|-----|
| App console | https://app.agentstudio.local:8443/console |
| Keycloak | https://auth.agentstudio.local:8443 |

Copy env and fill in your values (gitignored):

```bash
cp tests/integration/.env.example tests/integration/.env.local
```

Pytest loads **only** `.env.local`. Full template: `.env.example`.

### Common env vars

| Variable | Example | Purpose |
|----------|---------|---------|
| `API_BASE_URL` | `https://app.agentstudio.local:8443/config` | Config API base (no trailing slash) |
| `KEYCLOAK_TOKEN_URL` | *(optional)* derived from `API_BASE_URL` (`app.` → `auth.`, realm `nemo`) when unset | Token endpoint for login |
| `KEYCLOAK_PASSWORD_GRANT_CLIENT_ID` | `agent-studio-ui` | Password-grant OAuth client (legacy `KEYCLOAK_CLIENT_ID` still honored) |
| `KEYCLOAK_USERNAME` | `you@example.com` | Test user in realm `nemo` |
| `KEYCLOAK_PASSWORD` | `***` | User password |
| `KEYCLOAK_ENABLE_PASSWORD_GRANT` | `1` | Let pytest enable password grant on the client (local dev) |
| `CURL_INSECURE` | `1` | Skip TLS verify for self-signed local certs |
| `INTEGRATION_CLEANUP` | `1` | Delete project + credential/datasource/dataset/KB after each test (default). Set `0` to keep in the UI |

```bash
cd tests/integration
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export NO_PROXY='*'
```

## Clean results before a new run

Clear **report output and pytest cache** (does not delete projects/connectors in AgentStudio):

```bash
cd tests/integration
rm -rf reports/* .pytest_cache __pycache__ lib/__pycache__ suites/__pycache__
# or: make clean-reports
```

Then run tests again (see below). Fresh HTML, JUnit, and Allure files are written under `reports/`.

By default, each test **deletes** the project it created (and credential, datasource, dataset, KB). To **keep** them in the UI for inspection:

```bash
INTEGRATION_CLEANUP=0
```

**Clean reports + run all tests:**

```bash
cd tests/integration
rm -rf reports/* .pytest_cache __pycache__ lib/__pycache__ suites/__pycache__
source .venv/bin/activate
export NO_PROXY='*'
pytest -v -s
```

## Run tests

**One file:**

```bash
pytest suites/knowledge_base/test_create_project.py -v -s
```

**All suites** (every test under `suites/`, no tag filter):

```bash
pytest -v -s
```

**With make** (thin wrappers over the same `pytest` commands; run `make help` for the full list):

```bash
make setup          # create .venv + install requirements
make test           # full suite        (pytest -v -s)
make smoke          # pytest -m smoke
make kb             # pytest -m kb
make postgres       # pytest -m postgres
make mysql          # pytest -m mysql
make s3compatible   # pytest -m s3compatible
make knowledge-base  # pytest suites/knowledge_base
```

From the repo root you can run the same targets with `make -C tests/integration setup`, `make -C tests/integration test`, `make -C tests/integration smoke`, `make -C tests/integration kb`, and `make -C tests/integration clean-reports`.

**By tag (pytest marker)** — use `-m` to run a subset:

| Tag | Tests |
|-----|--------|
| `projects` | Project lifecycle happy path (create → get → list-with-role → rename → metrics → delete) |
| `members` | Project user-management happy path (add / change-role / remove member) — needs `MEMBER_TEST_EMAIL` |
| `models` | Model happy paths: platform-hosted built-in TEI models (zero-cred) + gated provider registration |
| `smoke` | Quick API smoke (the project lifecycle happy path) |
| `kb` | Knowledge-base pipelines (S3, Postgres, MySQL → dataset → KB → search) + KB happy path |
| `anf` | Azure NetApp Files metrics connector and/or managed MCP server |
| `metrics` | Metrics-as-resource dataset acquisition (subset of connector pipelines) |
| `mcp` | Managed MCP server provisioning and tool invocation |
| `ontap` | ONTAP metrics acquisition pipeline |

```bash
# specific tag
pytest -m kb -v -s
pytest -m postgres -v -s
pytest -m s3compatible -v -s
pytest -m gcp -v -s
pytest -m ontap -v -s

# multiple tags in one run
pytest -m "postgres or mysql" -v -s
pytest -m "kb and postgres" -v -s

# smoke only
pytest -m smoke -v -s

# exclude a tag
pytest -m "kb and not mysql" -v -s

# ANF (Azure NetApp Files) — requires local AgentStudio + Azure service principal
pytest -m anf -v -s
pytest -m "anf and metrics" -v -s
pytest -m "anf and mcp" -v -s
```

List registered tags: `pytest --markers`

### Happy-path suites (projects / members / models / kb)

UI-mirroring API happy paths under `suites/projects/`, `suites/models/`, and
`suites/knowledge_base/test_kb_happy_path.py`, reusing the root fixtures
(`platform_client`, `e2e_resources`). For what each suite validates, see
[integration-test-coverage.md](integration-test-coverage.md).

```bash
make smoke        # project lifecycle (also -m projects)
make projects
make members      # requires MEMBER_TEST_EMAIL
make models       # platform-hosted built-ins always run; provider registration gated
make kb           # KB happy path (+ existing connector pipelines)
```

Operational notes:
- `POST /projects` returns `201` immediately but project-init is **async**; the
  members and models suites wait until the per-project built-in models appear
  (`wait_for_project_ready`) before member writes (need project-admin) or model
  registration (needs the gateway virtual key).
- The `members` add path is resolve-or-create, so it provisions a Keycloak user
  that may linger after the project is deleted — keep it opt-in via
  `MEMBER_TEST_EMAIL`.
- The `roles` suite auto-provisions throwaway realm users via the Keycloak Admin
  API and **skips** when a master-realm admin token can't be obtained (grant
  disabled, or `KEYCLOAK_ADMIN_PASSWORD` missing/incorrect), so it never
  hard-errors a gate.

### Happy-path env vars

| Variable | Purpose |
|----------|---------|
| `MEMBER_TEST_EMAIL` | Target email for the `members` suite (skips if unset). |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | Alternative provider creds for `test_provider_model_registration.py` (or reuse `AZURE_OPENAI_*`). |
| `MODEL_PROVIDER_MODEL_ID` | Optional: pin the provider model id to register (else the first discovered model). |
| `MODEL_INFER` | `1` runs the live `/infer` assertion (needs a reachable provider + Bifrost VK). |
| `KB_SOURCE_DATASET_ID` | Reuse an existing READY dataset for the KB happy path (with `PROJECT_ID`); only the created KB is deleted. |
| `PROJECT_READY_TIMEOUT_SEC` | Project-init readiness poll timeout (default 300). |
| `MEMBER_WORKFLOW_TIMEOUT_SEC` | Membership workflow poll timeout (default 180). |
| `ROLE_TEST_PASSWORD` | Optional password for the two auto-provisioned role-test users (default generated). The users are created and deleted by the test via the Keycloak Admin API. |
| `KEYCLOAK_ADMIN_PASSWORD` | Master-realm admin password (`admin`/`admin-cli` password grant) for the `roles` suite's user provisioning. The suite **skips** when the admin token can't be obtained (grant disabled, or password missing/incorrect). |

### ANF (Azure NetApp Files)

Local-only tests for the account-scoped `azure_cloud` metrics connector and the managed `anf_mcp` server. Configure Azure variables in `.env.local` (see `.env.example`). Tests **skip** when credentials or ARM fixture IDs are missing, so CI stays green by default.

| Variable | Purpose |
|----------|---------|
| `AZURE_SUBSCRIPTION_ID` | Subscription containing ANF resources |
| `AZURE_DEFAULT_REGION` | Azure region (e.g. `eastus`) |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Service principal for `azure_cloud` credential |
| `AZURE_RESOURCE_GROUP` | Optional filter for metrics/MCP list operations |
| `ANF_TEST_POOL_ARM_ID`, `ANF_TEST_VOLUME_ARM_ID` | ARM ids for MCP read (and optional resize) tool calls |
| `ANF_METRIC_CATEGORIES` | Comma-separated metric categories (default `volume_metrics`) |
| `ANF_MCP_ALLOW_WRITE` | Set `1` to run grow-only resize tool tests (requires write RBAC) |

**RBAC:** Reader on subscription/ANF resources is enough for metrics acquisition and MCP read tools. Resize tests need `Microsoft.NetApp/netAppAccounts/capacityPools/write` and `.../volumes/write`.

```bash
pytest -m anf -v -s
pytest -m "anf and metrics" -v -s
pytest -m "anf and mcp" -v -s
```

### Agent-service (`agent_service`)

End-to-end tests for the agent-service, driven through the config-service for
provisioning (project → model → agent/team) and the agent-service for invocation
(sync HTTP, SSE streaming, WebSocket). All suites live under
`suites/agent_service/` and share fixtures in
`suites/agent_service/conftest.py`. For what each suite validates, see
[integration-test-coverage.md](integration-test-coverage.md).

**Setup requirements**

1. A reachable **agent-service** and **config-service** (set `AGENT_SERVICE_URL`
   and `CONFIG_SERVICE_URL` in `.env.local`). The suites **skip** when these are
   unset.
2. **Auth** (optional): when `ENABLE_AUTH_CONFIG_SERVICE` / `ENABLE_AUTH_AGENT_SERVICE`
   is `true`, the client fetches a Keycloak `client_credentials` bearer token using
   `KEYCLOAK_INTERNAL_ISSUER`, `KEYCLOAK_SERVICE_CLIENT_ID`, `KEYCLOAK_SERVICE_CLIENT_SECRET`
   (legacy `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET` still honored).
3. An **Azure OpenAI** credential (`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`,
   `AZURE_OPENAI_API_VERSION`) — the instantiation suite creates this credential
   before registering the model (config-service requires a `credentialId` for
   `provider=azure`).
4. The `kb_retrieval` suite needs an existing knowledge base (`KB_ID`); the KB is
   **not** created or deleted by the tests.

See the `AGENT_SERVICE` section in `.env.example` for the full list. Key variables:

| Variable | Purpose |
|----------|---------|
| `AGENT_SERVICE_URL` | Agent-service base URL (invoke / stream / websocket) |
| `CONFIG_SERVICE_URL` | Config-service base URL (provisioning) |
| `ENABLE_AUTH_CONFIG_SERVICE` / `ENABLE_AUTH_AGENT_SERVICE` | Toggle Keycloak bearer auth per service |
| `KEYCLOAK_INTERNAL_ISSUER` / `KEYCLOAK_SERVICE_CLIENT_ID` / `KEYCLOAK_SERVICE_CLIENT_SECRET` | Service-account creds (used only when auth is on; legacy `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET` still honored) |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_VERSION` | Azure OpenAI credential for the model |
| `PROJECT_ID` / `LLM_MODEL_ID` | Reuse an existing project / model (skip create + skip its deletion) |
| `AZURE_OPENAI_CRED_ID` | Reuse an existing Azure OpenAI credential (instantiation suite; skip create + skip its deletion) |
| `KB_ID` | Existing KB for the `kb_retrieval` suite (never created/deleted) |
| `INTEGRATION_CLEANUP` | `1` (default) deletes every project/model/agent/team a suite created; `0` keeps them |

**Run with make** (these set a per-run log dir under `reports/logs/<target>-<timestamp>/`):

```bash
make test_agent_service_all                    # every suite under suites/agent_service
make test_agent_service_instantiation
make test_agent_service_session
make test_agent_service_memory
make test_agent_service_orchestration_policy
make test_agent_service_guardrails
make test_agent_service_overrides
make test_agent_service_kb                      # kb_retrieval (RAG)
make test_agent_service_protocol                # HTTP + SSE + WebSocket
```

**Run with pytest** — by path or by marker:

```bash
# whole area
pytest suites/agent_service -v -s
pytest -m agent_service -v -s

# a single suite (path or marker)
pytest suites/agent_service/instantiation -v -s
pytest -m instantiation -v -s
pytest -m session -v -s
pytest -m orchestration -v -s
pytest -m guardrails -v -s
pytest -m overrides -v -s
pytest -m retrieval -v -s
pytest -m protocol -v -s
```

**Cleanup:** every suite tracks only the resources it creates and deletes them in
the after-class teardown when `INTEGRATION_CLEANUP=1` (default). Env-reused
`PROJECT_ID` / `LLM_MODEL_ID` / `AZURE_OPENAI_CRED_ID` and the `KB_ID` are never
deleted. Set
`INTEGRATION_CLEANUP=0` to keep created resources in the UI for debugging.

### Data management (`data_management`)

Live integration tests for **credential**, **datasource**, and **dataset** APIs under
`suites/data_management/`. These suites stop before KB creation (unlike `suites/knowledge_base/`).

| Suite (file pattern) | What it covers |
|----------------------|----------------|
| `test_credential_lifecycle.py` | Credential CRUD, validate, dependents, delete guards |
| `test_datasource_*.py` | Per-connector datasource lifecycle + connection test |
| `test_dataset_acquired_*.py` | Acquired structured (postgres/mysql) and unstructured (s3) |
| `test_dataset_metrics.py` | GCP / ONTAP / azure_cloud metrics datasets |
| `test_dataset_manual_unstructured.py` | Manual upload via S3 gateway → import → ready |
| `test_resource_dependencies.py` | Delete order: credential blocked while datasource exists |

**Run with make:**

```bash
make data-management    # all suites under suites/data_management
make credentials        # credential lifecycle (scoped to suites/data_management)
make datasources
make datasets
make manual-upload
```

Re-run `make setup` after pulling if you see `ModuleNotFoundError: no module named 'websockets'`
(marker-based targets under `suites/data_management` avoid importing agent-service conftest).

**Run with pytest:**

```bash
pytest suites/data_management -v -s
pytest -m data_management -v -s
pytest -m credential -v -s
pytest -m datasource -v -s
pytest -m dataset -v -s
pytest -m manual_upload -v -s
pytest -m connector_postgresql -v -s
```

Provider-specific tests **skip** when the corresponding env vars are unset (see `.env.example`
for `REDASH_*`, `VOLUME_*`, and existing `POSTGRES_*`, `S3_*`, etc.).

**Tag a new test** — register in `pytest.ini`, then on the module or function:

```python
import pytest

pytestmark = [pytest.mark.kb, pytest.mark.smoke]  # whole file

@pytest.mark.kb
def test_my_kb_flow():
    ...
```

Run your new tag: `pytest -m mytag -v -s`

Tests that need extra config in `.env.local` will **skip** automatically when that config is missing.

## View results

Reports are written under `tests/integration/reports/` (gitignored).


The Python package `allure-pytest` only **writes** `reports/allure-results/`. Viewing the report needs the **Allure CLI**, which requires a **Java runtime** (JDK 17 or 21 is fine).
1. Install Java — e.g. [Eclipse Temurin](https://adoptium.net/temurin/releases/) (macOS `.pkg` installer). Verify:
```bash
java -version
```

| Report | How to open |
|--------|-------------|
| **HTML** (default) | Open `reports/pytest-report.html` in a browser after each run |
| **JUnit** | `reports/junit.xml` — for CI or IDE import |
| **Allure** (recommended for failures) | Java + `npx --yes allure-commandline serve reports/allure-results` (no Homebrew required) |

The HTML report is a quick pass/fail summary. Allure shows step-by-step flow (project create, workflows, teardown) with attachments.

Pytest also prints report paths at the end of the session.

## Add a new test

1. Add a module under `suites/`, e.g. `suites/knowledge_base/test_my_flow.py` (or a new suite area such as `suites/agent_service/`).
2. Use session fixtures from `conftest.py`:
   - `integration_settings` — config from `.env.local`
   - `platform_client` — authenticated HTTP client
   - `e2e_resources` — tracks IDs created during the test; teardown runs by default (`INTEGRATION_CLEANUP=1`, set `0` to keep)
3. Reuse helpers in `lib/` (`lib.common.platform_client`, `lib.knowledge_base.pipeline_setup`, `lib.utils.waits`, `lib.utils.cleanup`, etc.) instead of duplicating API calls.
4. Register a marker in `pytest.ini` and tag the module. KB pipeline tests use `pytest.mark.kb`; run them with `pytest -m kb`. Run everything with plain `pytest -v -s` (no `-m`).


**Full E2E** — call a setup function from `lib/knowledge_base/pipeline_setup.py` inside a test that uses `e2e_resources` and `platform_client`, or follow an existing `suites/knowledge_base/test_*.py` file as a template.

## Layout

| Path | Role |
|------|------|
| `suites/` | Test modules (`knowledge_base/`, `agent_service/`) |
| `lib/common/` | Auth, HTTP client, settings, gateway URLs |
| `lib/utils/` | Generic helpers: waits, cleanup, SQL, object-store client |
| `lib/knowledge_base/` | Connector → dataset → KB pipeline setup |
| `lib/agent_service/` | Agent-service invoke/stream/websocket client + shared cleanup |
| `lib/config_service/` | Config-service provisioning client |
| `lib/models/` | Request models + `SuiteResources` cleanup ledger |
| `Makefile` | Convenience targets wrapping pytest |
| `.env.example` | Committed template |
| `.env.local` | Your secrets (gitignored) |
| `reports/` | HTML, JUnit, Allure output (gitignored) |
