# eval-worker dev harness

Local-process scaffolding for end-to-end smoke-testing the evaluation flow:
Temporal dev server + workflow-engine + eval-worker, all as native processes
on this dev container. The worker mocks the artifact store by default so PVC
writes stay local; `config-service` and `agent-service` are always real — set
`CONFIG_SERVICE_URL` and `AGENT_SERVICE_URL` before starting the worker.

## Prereqs

- `node` (>=20) — already on the dev container.
- `go` (>=1.24) — already on the dev container.
- `temporal` CLI — install with `./install-temporal.sh`.

## Quickstart

In four separate terminals (or use `--bg` to daemonise; see below):

```sh
# Terminal 1 — Temporal dev server (port 7233; web UI at :8233)
./scripts/dev-harness/install-temporal.sh   # one-time
./scripts/dev-harness/start-temporal.sh

# Terminal 2 — workflow-engine (port 8080)
./scripts/dev-harness/start-workflow-engine.sh

# Terminal 3 — eval-worker
./scripts/dev-harness/start-eval-worker.sh

# Terminal 4 — fire an evaluation
./scripts/dev-harness/trigger.sh
./scripts/dev-harness/trigger.sh --runMode regression
./scripts/dev-harness/trigger.sh --runMode ab_compare

You should see the trigger print:

1. `Starting evaluation` with the chosen run mode + `templateId` + `workflowId`.
2. Live progress lines as the workflow advances through preflight → running → scoring.
3. The `Results` block once the workflow is in a terminal state.
4. The final `Workflow return value` (the `EvaluationJob` row).

The Temporal Web UI at <http://localhost:8233> shows the workflow execution
tree (parent + per-case children).

## Background mode

Each `start-*.sh` accepts `--bg` to run detached and redirect output:

```sh
./scripts/dev-harness/start-temporal.sh --bg
./scripts/dev-harness/start-workflow-engine.sh --bg
./scripts/dev-harness/start-eval-worker.sh --bg
./scripts/dev-harness/trigger.sh
./scripts/dev-harness/stop-all.sh
```

Logs and pidfiles land in `./logs/`. `stop-all.sh` reads the pidfiles and
sends `SIGTERM` (then `SIGKILL` after 15s if needed).

## Storage

Artifact writes (`results.json`, `stakeholder-report.md`, `compare_report.json`)
land under `NEMO_DEFAULT_STORE_ROOT/projects/{projectId}/evaluations/{evalId}/runs/{runId}/`.

`start-eval-worker.sh` defaults `NEMO_DEFAULT_STORE_ROOT` to `/tmp/eval-worker-store`
so a local dev run never touches `/mnt/pvcs`. Override the env var to point
at a real shared mount when integrating against deployed services.

**config-service and agent-service are never mocked.** Set
`CONFIG_SERVICE_URL` + `AGENT_SERVICE_URL` to reachable services before
starting the worker — e.g. for a local `agent-service-maf` running on the
host:

```sh
AGENT_SERVICE_URL=http://host.docker.internal:8001/api/v1 \
  ./scripts/dev-harness/start-eval-worker.sh
```

## Common issues

- **`temporal: command not found`** — run `./install-temporal.sh`. It puts
  the binary in `~/.local/bin`. Make sure that dir is on your PATH.
- **`workflow-engine` exits with "MCP health schedule failed"** — there's a
  stale schedule registered against a previous Temporal dev server. Wipe it
  with `temporal operator namespace delete default && temporal operator
  namespace create default`, or just restart `start-temporal.sh` (the dev
  server uses an in-memory store, so schedules are gone on restart).
- **`eval-worker` keeps polling but workflow never starts** — check that
  `workflow-engine` is running on port 8080 and that the workflow shows up
  in the Temporal UI. The trigger script posts to `WORKFLOW_ENGINE_URL`
  (default `http://localhost:8080`).
- **`trigger.sh` returns 401 Unauthorized** — `workflow-engine` is enforcing
  auth. `start-workflow-engine.sh` unsets `KEYCLOAK_INTERNAL_ISSUER` so auth
  no-ops; if you customised that script make sure the env var is unset.

## Layout

```
scripts/dev-harness/
  README.md                      — this file
  install-temporal.sh            — installs the temporal CLI
  start-temporal.sh              — temporal server start-dev
  start-workflow-engine.sh       — go run cmd/server (auth off, schedules off)
  start-eval-worker.sh           — ts-node src/main.ts (mocks on)
  trigger.sh                     — ts-node scripts/trigger-eval.ts
  stop-all.sh                    — kills the *.sh --bg processes
  logs/                          — *.log + *.pid files
```
