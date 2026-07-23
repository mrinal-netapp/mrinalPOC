# artifact-service

Persistent, version-tracked artifact store for AgentStudio agents.

Each store is a **bare git repo** at
`/mnt/pvcs/default-nemo/projects/{projectId}/artifacts/{storeId}/`.
Operations are executed server-side via [isomorphic-git](https://isomorphic-git.org/);
agents reach the service through a 10-tool MCP surface
(`list_stores`, `whoami`, `read`, `list`, `write`, `delete`, `log`, `tag`,
`revert`, `merge`), and the GUI reads through a thin REST viewer.

## Layout

```
src/
  index.ts                       entrypoint
  server/Server.ts               BaseServer + route wiring
  server/routes/                 REST (catalog, viewer, merge, whoami)
  mcp/server.ts                  per-request McpServer + StreamableHTTP transport
  mcp/handlers.ts                10 v1 tool handlers
  mcp/schemas.ts                 zod input schemas
  engine/GitEngine.ts            isomorphic-git wrapper
  engine/CommitBuilder.ts        non-bypassable audit-trailer injection
  engine/RefResolver.ts          'SESSION' sentinel
  engine/LfsSidecar.ts           project-scoped CAS for blobs ≥ lfsThresholdBytes
  engine/PathResolver.ts         on-disk path layout
  acl/AclResolver.ts             principal × ACL row → effective role
  services/IdempotencyStore.ts   Redis-optional dedup cache (best-effort)
  db/Db.ts                       pg.Pool wrapper
  repo/StoreRepo.ts              raw SQL CRUD on artifact_stores
  repo/AclRepo.ts                raw SQL CRUD on artifact_store_acls
  middleware/auth.ts             principal from gateway-injected headers
  __tests__/                     62 unit + integration tests
```

## Audit invariant

Every commit goes through `CommitBuilder`, which non-bypassably appends
`X-Principal`, `X-Session-Id`, `X-Agent-Id`, `X-Team-Id`, `X-Op`, and
optionally `X-Idempotency-Key` to the message. The lint test
`__tests__/lint/commit-builder-only.test.ts` fails CI if any code outside
`GitEngine.ts` calls `git.writeCommit` / `git.commit`. The audit log is
then literally `git log --pretty='%H %an %ai %s%n%(trailers)'`.

## Env

| Var                       | Default                            | Notes                                                     |
| ------------------------- | ---------------------------------- | --------------------------------------------------------- |
| `PORT`                    | `8080`                             |                                                           |
| `LOG_LEVEL`               | `info`                             |                                                           |
| `NEMO_DEFAULT_STORE_ROOT` | `/mnt/pvcs/default-nemo`           | Where bare repos live                                     |
| `POSTGRES_HOST`           | `postgres`                         |                                                           |
| `POSTGRES_PORT`           | `5432`                             |                                                           |
| `POSTGRES_USER`           | `postgres`                         |                                                           |
| `POSTGRES_PASSWORD`       |                                    |                                                           |
| `POSTGRES_DB`             | `nemo`                             |                                                           |
| `REDIS_URL`               | (none)                             | Optional; idempotency dedup. Without it, degrades to miss |

## Tests

```bash
npm install
npm run build
npm test
```

62 tests covering the engine, ACL resolver, idempotency cache, and the
10 MCP tool handlers.

## End-to-end smoke

`scripts/e2e-smoke.sh` spins the built service against a temp NFS root
and a real Postgres (whose `synchronize` has created the tables), then
walks the happy path (create → write → log → read → tag → merge →
delete). Asserts that audit trailers are present on every commit.
