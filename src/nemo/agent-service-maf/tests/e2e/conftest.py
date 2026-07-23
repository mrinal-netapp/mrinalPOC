"""E2E test fixtures and helpers.

Provides two modes of operation:
1. **Process mode** (default): Starts the agent framework as a subprocess.
   Mock LLM and MCP services run as in-process ASGI apps via httpx.
2. **Docker mode** (--docker flag): Uses Docker Compose stack.

All E2E tests hit real HTTP endpoints via httpx (not ASGI TestClient).
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8000")
DEFAULT_LLM_URL = os.environ.get("E2E_LLM_URL", "http://localhost:4000")
# Host port 8090 maps to mock-mcp's container port 8080 (see
# docker/docker-compose.e2e.yml). Host 8080 was vacated to avoid colliding
# with the repo-root `bifrost` service.
DEFAULT_MCP_URL = os.environ.get("E2E_MCP_URL", "http://localhost:8090")
E2E_API_KEY = os.environ.get("E2E_API_KEY", "test-api-key-1")
E2E_TIMEOUT = float(os.environ.get("E2E_TIMEOUT", "10"))
HEALTH_CHECK_RETRIES = int(os.environ.get("E2E_HEALTH_RETRIES", "30"))
HEALTH_CHECK_INTERVAL = float(os.environ.get("E2E_HEALTH_INTERVAL", "1.0"))

# ---------------------------------------------------------------------------
# pytest options
# ---------------------------------------------------------------------------


def pytest_addoption(parser: Any) -> None:  # noqa: ANN401
    """Add E2E-specific command line options.

    Args:
        parser: The pytest argument parser.
    """
    parser.addoption(
        "--docker",
        action="store_true",
        default=False,
        help="Run E2E tests against Docker Compose stack instead of subprocess.",
    )
    parser.addoption(
        "--real-services",
        action="store_true",
        default=False,
        help="Run E2E tests against real external services (no mocks).",
    )
    parser.addoption(
        "--e2e-base-url",
        default=DEFAULT_BASE_URL,
        help="Base URL for the agent framework service.",
    )


# ---------------------------------------------------------------------------
# Health check helpers
# ---------------------------------------------------------------------------


def _wait_for_health(
    url: str,
    retries: int = HEALTH_CHECK_RETRIES,
    interval: float = HEALTH_CHECK_INTERVAL,
    service_name: str = "service",
) -> bool:
    """Wait for a service health endpoint to return 200.

    Args:
        url: The health check URL.
        retries: Maximum number of retries.
        interval: Seconds between retries.
        service_name: Service name for log messages.

    Returns:
        True if the service became healthy, False if all retries exhausted.
    """
    for _attempt in range(retries):
        try:
            resp = httpx.get(url, timeout=3.0)
            if resp.status_code == 200:
                return True
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout):
            pass
        time.sleep(interval)
    return False


def _find_free_port() -> int:
    """Find a free TCP port on localhost.

    Returns:
        Available port number.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Mock service subprocess management
# ---------------------------------------------------------------------------


def _start_mock_llm(port: int) -> subprocess.Popen[bytes]:
    """Start the mock LLM server as a subprocess.

    Args:
        port: Port to run on.

    Returns:
        The subprocess handle.
    """
    mock_llm_path = os.path.join(
        os.path.dirname(__file__), "..", "..", "docker", "mock-services", "mock_llm_server.py"
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = os.path.join(os.path.dirname(__file__), "..", "..", "src")
    proc: subprocess.Popen[bytes] = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "mock_llm_server:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
        ],
        cwd=os.path.dirname(mock_llm_path),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


def _start_mock_mcp(port: int) -> subprocess.Popen[bytes]:
    """Start the mock MCP server as a subprocess.

    Args:
        port: Port to run on.

    Returns:
        The subprocess handle.
    """
    mock_mcp_path = os.path.join(
        os.path.dirname(__file__), "..", "..", "docker", "mock-services", "mock_mcp_server.py"
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = os.path.join(os.path.dirname(__file__), "..", "..", "src")
    proc: subprocess.Popen[bytes] = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "mock_mcp_server:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
        ],
        cwd=os.path.dirname(mock_mcp_path),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


def _start_agent_framework(
    port: int,
    llm_port: int,
    mcp_port: int,
) -> subprocess.Popen[bytes]:
    """Start the agent framework as a subprocess.

    Creates a temporary working directory with an E2E-specific
    ``configs/agent_config.json`` so the JSON config tier uses the
    echo framework instead of the default semantic_kernel.

    Args:
        port: Port for the agent framework.
        llm_port: Port of the mock LLM service.
        mcp_port: Port of the mock MCP service.

    Returns:
        The subprocess handle.
    """
    import json
    import tempfile

    src_dir = os.path.join(os.path.dirname(__file__), "..", "..", "src")

    # Create a temp working directory with E2E config.
    work_dir = tempfile.mkdtemp(prefix="e2e_fw_")
    configs_dir = os.path.join(work_dir, "configs")
    os.makedirs(configs_dir, exist_ok=True)

    # Write E2E agent config (echo framework).
    from tests.conftest import TEST_PROJECT_ID

    e2e_config = {
        "project_id": TEST_PROJECT_ID,
        "agent": {
            "framework": "echo",
            "model": "mock-model",
            "temperature": 0.7,
            "max_tokens": 4096,
            "timeout_seconds": 30,
        },
        "interface": {
            "host": "0.0.0.0",
            "port": port,
            "cors_origins": [],
            "auth": {
                "enabled": True,
                "scheme": "api_key",
                "api_key_header": "X-API-Key",
                "api_keys": [],
            },
        },
        "gateway": {
            "url": f"http://localhost:{llm_port}",
            "api_key": "",
        },
        "guardrails": {
            "enabled": True,
            "fail_open": False,
        },
    }
    with open(os.path.join(configs_dir, "agent_config.json"), "w") as f:
        json.dump(e2e_config, f)

    env = os.environ.copy()
    env.update(
        {
            "PYTHONPATH": src_dir,
            "AGENT_AGENT__FRAMEWORK": "echo",
            "AGENT_AGENT__MODEL": "mock-model",
            # Bind is driven by uvicorn's --host / --port CLI flags
            # passed below; InterfaceSection no longer has host/port
            # fields.
            "AGENT_INTERFACE__AUTH__ENABLED": "true",
            "AGENT_INTERFACE__AUTH__API_KEYS": "test-api-key-1,test-api-key-2",
            "AGENT_GATEWAY__URL": f"http://localhost:{llm_port}",
            "AGENT_ENVIRONMENT": "development",
            "AGENT_GUARDRAILS__ENABLED": "true",
        }
    )
    proc: subprocess.Popen[bytes] = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "agent_service_maf.interface_layer.api:create_app",
            "--factory",
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
        ],
        cwd=work_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


def _stop_process(proc: subprocess.Popen[bytes]) -> None:
    """Stop a subprocess gracefully.

    Args:
        proc: The subprocess to stop.
    """
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


# ---------------------------------------------------------------------------
# Session-scoped fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def docker_mode(request: pytest.FixtureRequest) -> bool:
    """Whether to use Docker Compose mode.

    Args:
        request: Pytest fixture request.

    Returns:
        True if --docker flag is set.
    """
    val: bool = request.config.getoption("--docker", default=False)
    return val


@pytest.fixture(scope="session")
def e2e_ports() -> dict[str, int]:
    """Allocate free ports for E2E services.

    Returns:
        Dict with 'framework', 'llm', 'mcp' port numbers.
    """
    return {
        "framework": _find_free_port(),
        "llm": _find_free_port(),
        "mcp": _find_free_port(),
    }


@pytest.fixture(scope="session")
def e2e_services(
    docker_mode: bool,
    e2e_ports: dict[str, int],
) -> Iterator[dict[str, str]]:
    """Start E2E services and yield their URLs.

    In subprocess mode, starts mock LLM, mock MCP, and agent framework.
    In docker mode, expects services to be already running.

    Args:
        docker_mode: Whether Docker Compose is used.
        e2e_ports: Allocated ports.

    Yields:
        Dict with 'base_url', 'llm_url', 'mcp_url' values.
    """
    if docker_mode:
        # Docker mode: services are managed externally.
        urls = {
            "base_url": DEFAULT_BASE_URL,
            "llm_url": DEFAULT_LLM_URL,
            "mcp_url": DEFAULT_MCP_URL,
        }
        # Wait for all services to be healthy.
        for name, url in [
            ("agent-framework", f"{urls['base_url']}/health"),
            ("mock-llm", f"{urls['llm_url']}/health"),
            ("mock-mcp", f"{urls['mcp_url']}/health"),
        ]:
            healthy = _wait_for_health(url, service_name=name)
            if not healthy:
                pytest.skip(f"Docker service '{name}' not healthy at {url}")
        yield urls
        return

    # Subprocess mode: start services.
    llm_port = e2e_ports["llm"]
    mcp_port = e2e_ports["mcp"]
    fw_port = e2e_ports["framework"]

    procs: list[subprocess.Popen[bytes]] = []

    try:
        # Start mock services first.
        llm_proc = _start_mock_llm(llm_port)
        procs.append(llm_proc)
        mcp_proc = _start_mock_mcp(mcp_port)
        procs.append(mcp_proc)

        # Wait for mock services.
        llm_healthy = _wait_for_health(
            f"http://localhost:{llm_port}/health", service_name="mock-llm"
        )
        mcp_healthy = _wait_for_health(
            f"http://localhost:{mcp_port}/health", service_name="mock-mcp"
        )

        if not llm_healthy or not mcp_healthy:
            # Collect stderr for debugging.
            for p in procs:
                _stop_process(p)
            pytest.skip(
                "Mock services failed to start. "
                f"LLM healthy={llm_healthy}, MCP healthy={mcp_healthy}"
            )

        # Start agent framework.
        fw_proc = _start_agent_framework(fw_port, llm_port, mcp_port)
        procs.append(fw_proc)

        fw_healthy = _wait_for_health(
            f"http://localhost:{fw_port}/health", service_name="agent-framework"
        )
        if not fw_healthy:
            for p in procs:
                _stop_process(p)
            pytest.skip("Agent framework failed to start")

        yield {
            "base_url": f"http://localhost:{fw_port}",
            "llm_url": f"http://localhost:{llm_port}",
            "mcp_url": f"http://localhost:{mcp_port}",
        }

    finally:
        for p in reversed(procs):
            _stop_process(p)


# ---------------------------------------------------------------------------
# Test-scoped fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def base_url(e2e_services: dict[str, str]) -> str:
    """Get the agent framework base URL.

    Args:
        e2e_services: Service URLs from session fixture.

    Returns:
        Base URL string.
    """
    return e2e_services["base_url"]


@pytest.fixture
def llm_url(e2e_services: dict[str, str]) -> str:
    """Get the mock LLM service URL.

    Args:
        e2e_services: Service URLs from session fixture.

    Returns:
        LLM service URL string.
    """
    return e2e_services["llm_url"]


@pytest.fixture
def mcp_url(e2e_services: dict[str, str]) -> str:
    """Get the mock MCP service URL.

    Args:
        e2e_services: Service URLs from session fixture.

    Returns:
        MCP service URL string.
    """
    return e2e_services["mcp_url"]


@pytest.fixture
def api_key() -> str:
    """Get the E2E API key.

    Returns:
        API key string.
    """
    return E2E_API_KEY


@pytest.fixture
def auth_headers(api_key: str) -> dict[str, str]:
    """Get authentication headers for E2E requests.

    Args:
        api_key: The API key to use.

    Returns:
        Dict with X-API-Key header.
    """
    return {"X-API-Key": api_key}


@pytest.fixture
async def e2e_client(
    base_url: str, auth_headers: dict[str, str]
) -> AsyncIterator[httpx.AsyncClient]:
    """Create an authenticated async HTTP client for E2E tests.

    Args:
        base_url: The framework base URL.
        auth_headers: Authentication headers.

    Yields:
        Configured httpx AsyncClient.
    """
    async with httpx.AsyncClient(
        base_url=base_url,
        headers=auth_headers,
        timeout=E2E_TIMEOUT,
    ) as client:
        yield client


@pytest.fixture
async def unauth_client(base_url: str) -> AsyncIterator[httpx.AsyncClient]:
    """Create an unauthenticated async HTTP client for E2E tests.

    Args:
        base_url: The framework base URL.

    Yields:
        Configured httpx AsyncClient without auth headers.
    """
    async with httpx.AsyncClient(
        base_url=base_url,
        timeout=E2E_TIMEOUT,
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Request helper
# ---------------------------------------------------------------------------


def make_invoke_payload(
    input_text: str = "Hello from E2E test",
    context: dict[str, Any] | None = None,
    config_overrides: dict[str, Any] | None = None,
    session_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build an InvokeRequest payload for E2E tests.

    Args:
        input_text: The user input text.
        context: Additional context dict.
        config_overrides: Per-request config overrides.
        session_id: Optional session ID.
        metadata: Optional metadata dict.

    Returns:
        Dict matching the InvokeRequest schema.
    """
    payload: dict[str, Any] = {"input": input_text}
    if context is not None:
        payload["context"] = context
    if config_overrides is not None:
        payload["config_overrides"] = config_overrides
    if session_id is not None:
        payload["session_id"] = session_id
    if metadata is not None:
        payload["metadata"] = metadata
    return payload
