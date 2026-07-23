# Agent Service Hardening — Design Document

This document specifies the fixes to `agent-service` for reliable structured output (outcomeSchema), guardrails enforcement, and tool filtering (allowedTools).

## Doc map

- **Motivation** — Why these fixes are critical for pipeline reliability.
- **outcomeSchema type mapping** — Correct JSON Schema → Python type mapping.
- **Nested objects and arrays** — Recursive model generation.
- **Guardrails enforcement** — Wiring maxIterations and timeoutSeconds.
- **allowedTools filtering** — Per-MCP-server tool whitelist.
- **Structured output parsing** — Guaranteeing valid JSON from agent responses.
- **Backward compatibility** — Ensuring existing agents are unaffected.
- **Testing strategy** — Unit, integration tests.

---

## Motivation

The pipeline engine depends on agent-service returning structured, parseable JSON that conforms to a declared schema. Currently:

1. `outcomeSchema` type mapping uses raw JSON Schema types (`"string"`, `"array"`) as Python type annotations, causing runtime failures
2. `guardrails` config is stored but never enforced — agents can run indefinitely
3. `allowedTools` config is stored but all MCP tools remain available — no write-gating

These must be fixed before pipeline agent blocks work reliably.

---

## outcomeSchema Type Mapping

### Current Problem

In `agent_factory.py`, the schema-to-Pydantic conversion does:
```python
field_type = prop.get("type", "string")  # Returns "string", "array", etc.
```

This raw string is used directly as a Python type annotation, which fails at runtime.

### Fix: Proper Mapping

```python
JSON_SCHEMA_TYPE_MAP = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
    "null": type(None),
}
```

### Implementation

```python
def resolve_field_type(prop: dict, definitions: dict = None) -> type:
    """Convert a JSON Schema property definition to a Python type."""
    schema_type = prop.get("type", "string")
    
    # Handle arrays with typed items
    if schema_type == "array":
        items = prop.get("items", {})
        if items:
            item_type = resolve_field_type(items, definitions)
            return List[item_type]
        return list
    
    # Handle nested objects
    if schema_type == "object":
        properties = prop.get("properties")
        if properties:
            return create_nested_model(prop, definitions)
        return dict
    
    # Handle $ref
    if "$ref" in prop:
        ref_path = prop["$ref"].split("/")[-1]
        ref_schema = definitions.get(ref_path, {})
        return resolve_field_type(ref_schema, definitions)
    
    # Handle enum
    if "enum" in prop:
        return str  # Enum values validated post-hoc
    
    return JSON_SCHEMA_TYPE_MAP.get(schema_type, str)
```

### Nested Objects (Recursive)

```python
def create_nested_model(schema: dict, definitions: dict = None) -> type:
    """Recursively create a Pydantic model from a JSON Schema object."""
    title = schema.get("title", f"Model_{uuid4().hex[:8]}")
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    
    fields = {}
    for name, prop in properties.items():
        field_type = resolve_field_type(prop, definitions)
        if name in required:
            fields[name] = (field_type, ...)
        else:
            fields[name] = (Optional[field_type], None)
    
    return create_model(title, **fields)
```

### Required vs Optional

- Fields listed in `"required"` array → non-Optional (must be present)
- Fields NOT in `"required"` → `Optional[T]` with default `None`

---

## Guardrails Enforcement

### Current Problem

Agent config contains:
```json
{
  "guardrails": {
    "maxIterations": 50,
    "timeoutSeconds": 600
  }
}
```

But `agent_factory.py` never reads these values.

### Fix

In the agent creation path:

```python
def create_agent(config: AgentConfig) -> Agent:
    guardrails = config.get("guardrails", {})
    max_iterations = guardrails.get("maxIterations", 25)  # safe default
    timeout_seconds = guardrails.get("timeoutSeconds", 300)  # safe default
    
    agent = Agent(
        model=model,
        tools=filtered_tools,
        instructions=config["systemPrompt"],
        max_iterations=max_iterations,  # Agno's built-in limit
        # ... other config
    )
    return agent, timeout_seconds
```

### Timeout Enforcement

At invocation time:

```python
async def invoke_agent(agent: Agent, message: str, timeout: int) -> str:
    try:
        result = await asyncio.wait_for(
            agent.arun(message),
            timeout=timeout,
        )
        return result
    except asyncio.TimeoutError:
        raise AgentTimeoutError(
            f"Agent exceeded timeout of {timeout}s"
        )
```

### Behavior

- `maxIterations`: If the agent has not produced a final answer after N tool-call iterations, Agno stops it and returns the last state
- `timeoutSeconds`: Hard wall-clock timeout. Agent is cancelled regardless of iteration count.
- Both protections prevent runaway agents from consuming unbounded resources during pipeline execution.

---

## allowedTools Filtering

### Current Problem

Agent config contains per-MCP-server allowed tools:
```json
{
  "mcpServers": [
    {
      "serverId": "ontap-mcp",
      "allowedTools": ["resize_volume", "create_snapshot", "set_volume_qos"]
    }
  ]
}
```

But all tools from attached MCP servers are loaded regardless.

### Fix

After loading tools from MCP servers, filter:

```python
def filter_tools(loaded_tools: list, mcp_configs: list) -> list:
    """Filter loaded tools by per-server allowedTools whitelist."""
    # Build lookup: tool_name → allowed?
    allowed_tools = set()
    has_whitelist = False
    
    for mcp_config in mcp_configs:
        server_allowed = mcp_config.get("allowedTools")
        if server_allowed is not None:
            has_whitelist = True
            allowed_tools.update(server_allowed)
    
    # If no allowedTools configured anywhere, return all (backward compatible)
    if not has_whitelist:
        return loaded_tools
    
    # Filter
    return [tool for tool in loaded_tools if tool.name in allowed_tools]
```

### Security Implication

For the Executor Agent, this ensures it can only call write operations that are explicitly whitelisted. Even if the LLM attempts to call other tools, they won't be available in the tool registry.

---

## Structured Output Parsing

### Problem

When `outcomeSchema` is set, the pipeline expects the agent's response to be valid JSON. However, Agno may return the structured output wrapped in markdown code blocks or as a plain text response.

### Solution

Add a post-processing step:

```python
def extract_structured_output(response: str, has_schema: bool) -> str:
    """Ensure response is valid JSON when outcomeSchema is configured."""
    if not has_schema:
        return response
    
    # Try direct JSON parse
    try:
        json.loads(response)
        return response
    except json.JSONDecodeError:
        pass
    
    # Strip markdown code block wrapper
    stripped = response.strip()
    if stripped.startswith("```json"):
        stripped = stripped[7:]
    elif stripped.startswith("```"):
        stripped = stripped[3:]
    if stripped.endswith("```"):
        stripped = stripped[:-3]
    stripped = stripped.strip()
    
    try:
        json.loads(stripped)
        return stripped
    except json.JSONDecodeError:
        # Last resort: return as-is, let caller handle parse error
        return response
```

### API Response

When `outcomeSchema` is set, the invoke response includes:
```json
{
  "status": "completed",
  "response": "{\"recommendations\": [...]}",
  "parsedOutput": { "recommendations": [...] }
}
```

The `parsedOutput` field is present only when `outcomeSchema` is configured and parsing succeeds. This allows the pipeline engine to use `parsedOutput` directly without re-parsing.

---

## Backward Compatibility

| Change | Impact on Existing Agents |
|--------|--------------------------|
| Type mapping fix | Only affects agents WITH `outcomeSchema` (currently broken anyway) |
| Guardrails enforcement | Uses defaults (25 iterations, 300s) if not configured — matches Agno defaults |
| allowedTools filtering | Only activates when `allowedTools` is explicitly set; agents without it keep all tools |
| Structured output extraction | Only runs when `outcomeSchema` present; agents without schema are unaffected |

All changes are additive/opt-in. Existing agents without these configs behave identically.

---

## Testing Strategy

### Unit Tests
- Type mapping: all JSON Schema types including nested objects, arrays of objects, optional fields
- `create_nested_model`: recursive with 3+ levels deep
- `filter_tools`: empty whitelist, partial whitelist, no whitelist
- `extract_structured_output`: raw JSON, markdown-wrapped, invalid content
- Guardrails: verify `max_iterations` and timeout are passed correctly

### Integration Tests
- Create agent with `outcomeSchema` → invoke → verify response is valid JSON matching schema
- Create agent with `guardrails.maxIterations=3` → invoke with task requiring many tool calls → verify it stops
- Create agent with `allowedTools=["tool_a"]` → verify only `tool_a` is available during execution
- Timeout test: agent with 5s timeout and slow tool → verify `AgentTimeoutError`

### Regression Tests
- Existing agents (no schema, no guardrails, no allowedTools) continue to work unchanged
- Agent with partial config (only guardrails, no schema) works correctly
