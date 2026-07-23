# common-go

Shared Go libraries for AgentStudio services — the Go counterpart to `src/common/` (TypeScript).

## Packages

### `secrets-client`

Go parity library for the Secrets Store CSI Driver integration.
Reads secrets from CSI-mounted files under `/mnt/secrets/<group>/<key>` and provides live rotation via fsnotify-backed file watching.

See [`secrets-client/`](./secrets-client/) for full API and usage.

## Usage

Add as a local dependency in your service's `go.mod`:

```
require github.com/agentstudio/common/secrets-client v0.0.0

replace github.com/agentstudio/common/secrets-client => ../../common-go/secrets-client
```

Then run `go mod tidy`.
