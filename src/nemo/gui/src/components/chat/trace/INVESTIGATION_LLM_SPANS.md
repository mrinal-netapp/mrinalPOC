# LLM span message inflation (investigation notes)

## Context

Child spans such as `LiteLLM.ainvoke_stream` are recorded by **OpenInference `AgnoInstrumentor`** in agent-service (`tracing.py`), not by AgentStudio application code. The span name comes from Agno's upstream SDK (`agno.models.litellm.LiteLLM`) — Agno uses the `litellm` Python SDK internally as a client even though AgentStudio routes through the Bifrost gateway. Attributes (`input.value`, `output.value`, message lists) reflect what Agno sends on each call.

## Hypotheses

1. **Full history per call** — Each LLM invocation includes the entire conversation; the instrumentor serializes the full `messages[]` (expected, not a bug).
2. **Tool loop** — Multiple assistant/tool rounds in one `arun` appear as many blocks in one streaming span.
3. **History assembly** — `_build_message_with_history_fallback` may duplicate the latest user turn in structured messages (verify in agent-service).
4. **Instrumentor** — Unlikely buffer-append bug; confirm with a minimal single-turn trace.

## How to reproduce

1. **Single-turn, no tools, new session**: Capture Phoenix Attributes for the LLM span; count entries in `messages` (or `input.value`).
2. **Multi-turn with tools**: Compare message count growth vs turns.
3. **Retry in chat**: Each retry is a **new** HTTP stream and a **new** OTel trace id; compare **separate** traces, not one span.

## Outcome (fill in)

- [ ] Single-turn message count: ___
- [ ] Multi-turn observation: ___
- [ ] Conclusion: expected / document UX mitigations / file upstream issue

## Mitigation (GUI, optional)

If behavior is expected: show message count in I/O tab, or “last K messages” collapse — tracked separately after confirmation.
