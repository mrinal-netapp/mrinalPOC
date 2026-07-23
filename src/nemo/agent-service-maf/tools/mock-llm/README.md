# mock-llm

Deterministic mock LLM gateway used by the Bruno test folder at
`bruno/output-schema/` (inside the MAF Bruno collection) and by any
pytest e2e suite that wants reproducible LLM output.

## Why this exists

The Option-B output-schema validator (see
`docs/spec/MigrationToNewRepo/maf-output-schema-validation-plan.md`)
needs deterministic LLM replies to assert against. Real Bifrost +
provider routes are too noisy for "assert `parsedOutput.customerId ==
\"acme-123\"`" style assertions.

## Layout

```
tools/mock-llm/
├── app.py            # FastAPI app exposing /v1/chat/completions
├── fixtures.yaml     # match_input → response rules (first match wins)
├── Dockerfile        # python:3.12-slim base, ~80 MB image
└── README.md         # this file
```

## Run locally

```bash
cd tools/mock-llm
pip install fastapi uvicorn pyyaml
uvicorn app:app --host 0.0.0.0 --port 4000
```

Point MAF at it:

```bash
export AGENT_GATEWAY__URL=http://localhost:4000/v1
```

Then `curl localhost:4000/healthz` confirms the service is up and
`fixtures_loaded` is non-zero.

## Add a fixture

Append to `fixtures.yaml`:

```yaml
- match_input: "give me JSON about cats"
  response: '{"animal": "cat", "count": 9}'
```

Match is case-insensitive substring against the **user's last
message**. First matching rule wins. Restart the container (or set
`MOCK_LLM_HOT_RELOAD=1` and edit live).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MOCK_LLM_FIXTURES` | `/app/fixtures.yaml` | Path to the fixtures YAML. |
| `MOCK_LLM_DEFAULT_REPLY` | `MOCK_LLM_NO_FIXTURE_MATCHED` | Returned when no rule matches. Failing assertions is the point. |
| `MOCK_LLM_HOT_RELOAD` | `0` | When `1`, re-reads `fixtures.yaml` on every request. |
