#!/usr/bin/env bash
# Smoke-test ONTAP log MCP tools against a running supergateway (streamable HTTP).
# Usage:
#   export ONTAP_CLUSTER_URL=https://<mgmt-lif>
#   export ONTAP_USERNAME=...
#   export ONTAP_PASSWORD=...
#   export ONTAP_VERIFY_TLS=false   # lab only
#   export NO_PROXY=<mgmt-lip>,localhost,127.0.0.1
#   export ONTAP_TRUST_ENV=false    # if corporate proxy blocks private IPs
#
# Terminal 1:
#   npx -y supergateway --stdio "python3 server.py" --outputTransport streamableHttp --port 8000
#
# Terminal 2:
#   ./scripts/test_log_mcp.sh http://localhost:8000/mcp

set -euo pipefail

MCP_URL="${1:-http://localhost:8000/mcp}"

python3 - "$MCP_URL" << 'PY'
import json
import os
import sys
import requests

mcp = sys.argv[1]
headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
session = requests.Session()
if os.environ.get("ONTAP_TRUST_ENV", "").lower() in ("false", "0", "no"):
    session.trust_env = False


def post(payload, timeout=60):
    r = session.post(mcp, headers=headers, json=payload, timeout=timeout, stream=True)
    for line in r.iter_lines(decode_unicode=True):
        if line and line.startswith("data:"):
            return json.loads(line[5:].strip()), r.status_code
    return None, r.status_code


def call_tool(name, arguments):
    post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}
    }})
    session.post(mcp, headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=10)
    res, status = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
    print(f"\n=== {name} (HTTP {status}) ===")
    if not res:
        print("No SSE data returned")
        return
    content = res.get("result", {}).get("content", [])
    text = content[0].get("text") if content else json.dumps(res, indent=2)
    try:
        print(json.dumps(json.loads(text), indent=2)[:6000])
    except json.JSONDecodeError:
        print(text[:6000])


_, _ = post({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
    "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}
}})
session.post(mcp, headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=10)
tools, _ = post({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
names = [t["name"] for t in tools.get("result", {}).get("tools", [])] if tools else []
print("Log tools:", [n for n in names if "ems" in n or "audit" in n])
for required in ("query_ems_events", "query_audit_messages", "lookup_ems_message", "get_ems_event"):
    if required not in names:
        raise SystemExit(f"Missing tool: {required}")

call_tool("query_ems_events", {"max_records": 5, "message_severity": "alert,error,notice", "hours": 720})
call_tool("query_audit_messages", {"max_records": 5, "hours": 720})
print("\nOK")
PY
