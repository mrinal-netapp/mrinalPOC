"""MCP Server adapter — exposes agents AS MCP tools.

When this service runs in MCP server mode, external tools (Claude Desktop,
other agents, etc.) can discover and invoke agents via the Model Context Protocol.

Each registered agent framework becomes an MCP tool:
  - invoke_maf(input, session_id?, config_overrides?)
  - invoke_agent(framework, input, session_id?, config_overrides?)  # generic

Supports both stdio and SSE transports.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import structlog

from agent_service_maf.config.config_loader import ConfigLoader
from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.service import AgentService
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.gateway.llm_gateway import LLMGateway
from agent_service_maf.mcp.mcp_registry import MCPRegistry

logger = structlog.get_logger(__name__)


class MCPServerAdapter:
    """Wraps AgentService as an MCP server.

    Dynamically registers MCP tools for each available agent framework.
    Uses the `mcp` Python SDK for server implementation.
    """

    def __init__(self, agent_service: AgentService, config: AgentConfig) -> None:
        self._service = agent_service
        self._config = config
        self._server: Any = None  # mcp.server.Server instance

    async def create_server(self) -> Any:
        """Create and configure the MCP server with agent tools.

        Returns the configured mcp.server.Server instance.
        """
        try:
            from mcp.server import Server
            from mcp.types import (
                TextContent,
                Tool,
            )
        except ImportError:
            raise RuntimeError(
                "MCP server mode requires the 'mcp' package. Install with: pip install 'mcp>=1.0'"
            )

        server_config = self._config.mcp_server
        server = Server(server_config.server_name)
        self._server = server

        # --- Tool Registration ---

        # Discover all registered frameworks
        frameworks = FrameworkRegistry.list_frameworks()

        # Build tool definitions
        tool_definitions: dict[str, Tool] = {}

        # Per-framework tools (e.g., invoke_maf, invoke_echo)
        for framework_name in frameworks:
            tool_name = f"invoke_{framework_name}"
            tool_definitions[tool_name] = Tool(
                name=tool_name,
                description=(
                    f"Invoke the {framework_name} agent framework. "
                    f"Sends a prompt to an agent running on {framework_name} "
                    f"and returns the response."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "input": {
                            "type": "string",
                            "description": "The prompt / input for the agent",
                        },
                        "agent_id": {
                            "type": "string",
                            "description": "Agent identifier (default: framework name)",
                            "default": framework_name,
                        },
                        "session_id": {
                            "type": "string",
                            "description": "Optional session ID for conversation continuity",
                        },
                        "config_overrides": {
                            "type": "object",
                            "description": "Optional runtime config overrides",
                            "default": {},
                        },
                    },
                    "required": ["input"],
                },
            )

        # Generic invoke_agent tool
        tool_definitions["invoke_agent"] = Tool(
            name="invoke_agent",
            description=(
                "Invoke an agent using any registered framework. "
                "Specify the framework explicitly via config_overrides "
                "or use the server's default framework."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "input": {
                        "type": "string",
                        "description": "The prompt / input for the agent",
                    },
                    "agent_id": {
                        "type": "string",
                        "description": "Agent identifier",
                        "default": "default",
                    },
                    "framework": {
                        "type": "string",
                        "description": f"Framework to use. Available: {', '.join(frameworks)}",
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Optional session ID for conversation continuity",
                    },
                    "config_overrides": {
                        "type": "object",
                        "description": "Optional runtime config overrides",
                        "default": {},
                    },
                },
                "required": ["input"],
            },
        )

        # --- MCP Handlers ---

        @server.list_tools()
        async def handle_list_tools() -> list[Tool]:
            return list(tool_definitions.values())

        @server.call_tool()
        async def handle_call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
            return await self._handle_tool_call(name, arguments, frameworks)

        return server

    async def _handle_tool_call(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        frameworks: list[str],
    ) -> list[Any]:
        """Handle an MCP tool call by delegating to AgentService."""
        try:
            from mcp.types import TextContent
        except ImportError:
            raise RuntimeError("MCP package required for server mode")

        input_text = arguments.get("input", "")
        agent_id = arguments.get("agent_id", "default")
        session_id = arguments.get("session_id")
        config_overrides = arguments.get("config_overrides", {})

        # Determine framework from tool name or arguments
        if tool_name.startswith("invoke_") and tool_name != "invoke_agent":
            framework = tool_name.replace("invoke_", "")
            config_overrides.setdefault("agent", {})["framework"] = framework
        elif tool_name == "invoke_agent":
            framework = arguments.get("framework")
            if framework:
                config_overrides.setdefault("agent", {})["framework"] = framework

        try:
            response = await self._service.invoke(
                agent_id=agent_id,
                input_text=input_text,
                session_id=session_id,
                config_overrides=config_overrides,
                metadata={"source": "mcp", "tool_name": tool_name},
            )

            # Return response as MCP TextContent
            result = {
                "output": response.output,
                "agent_id": response.agent_id,
                "duration_ms": response.duration_ms,
            }
            if response.usage:
                result["usage"] = response.usage.model_dump()
            if response.artifacts:
                result["artifacts"] = response.artifacts

            return [TextContent(type="text", text=json.dumps(result, indent=2))]

        except Exception as e:
            logger.error("MCP tool call failed", tool=tool_name, error=str(e))
            return [
                TextContent(
                    type="text",
                    text=json.dumps({"error": str(e), "error_type": type(e).__name__}),
                )
            ]

    async def run_stdio(self) -> None:
        """Run the MCP server over stdio transport."""
        try:
            from mcp.server.stdio import stdio_server
        except ImportError:
            raise RuntimeError("MCP package required for server mode")

        server = await self.create_server()
        logger.info("Starting MCP server (stdio transport)")

        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options(),
            )

    async def run_sse(self, host: str = "0.0.0.0", port: int = 8001) -> None:
        """Run the MCP server over SSE transport."""
        try:
            from mcp.server.sse import SseServerTransport
        except ImportError:
            raise RuntimeError("MCP package required for server mode")

        import uvicorn
        from starlette.applications import Starlette
        from starlette.routing import Route

        server = await self.create_server()
        sse_transport = SseServerTransport("/messages")

        async def handle_sse(request: Any) -> Any:
            async with sse_transport.connect_sse(
                request.scope, request.receive, request._send
            ) as streams:
                await server.run(
                    streams[0],
                    streams[1],
                    server.create_initialization_options(),
                )

        starlette_app = Starlette(
            routes=[
                Route("/sse", endpoint=handle_sse),
                Route("/messages", endpoint=sse_transport.handle_post_message, methods=["POST"]),
            ],
        )

        logger.info("Starting MCP server (SSE transport)", host=host, port=port)
        config = uvicorn.Config(starlette_app, host=host, port=port, log_level="info")
        server_instance = uvicorn.Server(config)
        await server_instance.serve()


#: Default SSE bind host for the MCP-server launcher. ``127.0.0.1`` is
#: the safe default — the MCP-server protocol exposes admin-like tool
#: invocation, so binding to all interfaces by default would be a
#: security footgun. Operators who genuinely need external reachability
#: must opt in via ``AGENT_MCP_SERVER__SSE_HOST=0.0.0.0`` (or any other
#: bind address), making the exposure choice explicit and auditable.
_DEFAULT_SSE_HOST = "127.0.0.1"


def _resolve_sse_host(config: Any) -> str:  # noqa: ANN401
    """Pick the SSE bind host for ``run_mcp_server``.

    Precedence (highest → lowest):

    1. ``AGENT_MCP_SERVER__SSE_HOST`` environment variable.
    2. ``config.mcp_server.sse_host`` from the resolved AgentConfig
       (loaded via JSON / env tier merge).
    3. :data:`_DEFAULT_SSE_HOST` (``127.0.0.1`` — loopback only).

    Returning loopback by default means a ``python -m
    agent_service_maf.interface_layer.protocols.mcp_server`` run on a
    laptop never exposes the admin protocol to the network — the
    operator has to explicitly set the env var to widen the bind.
    """
    env_host = os.environ.get("AGENT_MCP_SERVER__SSE_HOST", "").strip()
    if env_host:
        return env_host
    cfg_section = getattr(config, "mcp_server", None)
    cfg_host = getattr(cfg_section, "sse_host", None) if cfg_section else None
    if isinstance(cfg_host, str) and cfg_host.strip():
        return cfg_host.strip()
    return _DEFAULT_SSE_HOST


async def run_mcp_server(
    config_path: str = "configs/agent_config.json",
    transport: str | None = None,
) -> None:
    """Entry point for running the service in MCP server mode.

    Usage:
        python -m agent_service_maf.interface_layer.protocols.mcp_server

    The SSE bind host defaults to ``127.0.0.1`` (loopback only). To
    expose the MCP protocol on other interfaces, set
    ``AGENT_MCP_SERVER__SSE_HOST`` (e.g. ``0.0.0.0`` for all interfaces
    or a specific NIC's IP). Making the choice explicit avoids the
    common dev-time mistake of leaving an admin-like endpoint reachable
    from the network.
    """
    config_loader = ConfigLoader(json_config_path=config_path)
    config = config_loader.resolve()

    gateway = LLMGateway(config.gateway)
    mcp_registry = MCPRegistry(config.mcp)

    service = AgentService(
        config_loader=config_loader,
        gateway=gateway,
        mcp_registry=mcp_registry,
    )
    await service.start()

    adapter = MCPServerAdapter(agent_service=service, config=config)

    effective_transport = transport or config.mcp_server.transport

    try:
        if effective_transport == "stdio":
            await adapter.run_stdio()
        elif effective_transport == "sse":
            sse_host = _resolve_sse_host(config)
            if sse_host == "0.0.0.0":
                # Loud heads-up so an accidental all-interfaces bind is
                # visible in operator logs / log aggregation. The route
                # exposes admin-like tool invocation; exposing it to
                # the network is a deliberate ops choice.
                logger.warning(
                    "MCP SSE bound to 0.0.0.0 — exposed on all interfaces. "
                    "Confirm this is intentional; otherwise unset "
                    "AGENT_MCP_SERVER__SSE_HOST or set it to 127.0.0.1.",
                )
            await adapter.run_sse(
                host=sse_host,
                port=config.mcp_server.sse_port,
            )
        else:
            raise ValueError(f"Unknown MCP transport: {effective_transport}")
    finally:
        await service.stop()
        await mcp_registry.shutdown()


if __name__ == "__main__":
    import sys

    transport_arg = sys.argv[1] if len(sys.argv) > 1 else None
    asyncio.run(run_mcp_server(transport=transport_arg))
