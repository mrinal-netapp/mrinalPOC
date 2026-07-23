"""
Model registration validation matrix (deterministic, no external calls).

Asserts config-service's request validation + per-provider runtime rules without
depending on any real provider/gateway connectivity:
  - field/enum validation (name, provider, modelType, spendingLimitPeriod) -> 400
  - credentialId required for each remote provider -> 400
  - endpoint required for ollama -> 400
  - embedding without resolvable dimensions -> 400 EMBEDDING_DIMENSIONS_REQUIRED
  - duplicate name (using a seeded built-in's name) -> 409

Rules: validators/modelValidator.ts + routes/modelRoutes.ts.
"""

from __future__ import annotations

import os

import allure
import pytest

from lib.common.platform_client import PlatformClient, unique_name
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_platform_project_ready

pytestmark = [
    pytest.mark.models,
    allure.feature("Model validation matrix"),
]

REMOTE_PROVIDERS = ["openai", "openai_compatible", "aws_bedrock", "azure", "google"]


def _project_ready_timeout() -> int:
    return int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300")


@pytest.fixture
def ready_project(created_project: PipelineResources, platform_client: PlatformClient):
    wait_for_platform_project_ready(
        platform_client,
        created_project.project_id,
        timeout_sec=_project_ready_timeout(),
    )
    prefix = platform_client.project_prefix(created_project.project_id)
    return created_project, prefix


@allure.title("Create validation: field + enum errors -> 400")
def test_model_create_field_validation(
    ready_project, platform_client: PlatformClient
) -> None:
    _, prefix = ready_project
    cases = [
        ("missing name", {"provider": "openai"}),
        ("bad provider", {"name": unique_name("m"), "provider": "local"}),
        ("bad modelType", {"name": unique_name("m"), "modelType": "vision"}),
        (
            "bad spendingLimitPeriod",
            {"name": unique_name("m"), "spendingLimitPeriod": "year"},
        ),
    ]
    for label, body in cases:
        resp = platform_client.config_post(f"{prefix}/models", body)
        assert resp.status_code == 400, f"{label}: expected 400, got {resp.status_code}: {resp.text}"


@pytest.mark.parametrize("provider", REMOTE_PROVIDERS)
@allure.title("Remote provider without credentialId -> 400")
def test_remote_provider_requires_credential(
    ready_project, platform_client: PlatformClient, provider: str
) -> None:
    _, prefix = ready_project
    resp = platform_client.config_post(
        f"{prefix}/models",
        {"name": unique_name(f"m-{provider}"), "provider": provider, "modelType": "llm"},
    )
    assert resp.status_code == 400, f"{provider}: {resp.status_code} {resp.text}"
    assert "credentialid is required" in resp.text.lower(), resp.text


@allure.title("ollama without endpoint -> 400")
def test_ollama_requires_endpoint(ready_project, platform_client: PlatformClient) -> None:
    _, prefix = ready_project
    resp = platform_client.config_post(
        f"{prefix}/models",
        {"name": unique_name("m-ollama"), "provider": "ollama", "modelType": "llm"},
    )
    assert resp.status_code == 400, resp.text
    assert "endpoint is required" in resp.text.lower(), resp.text


@allure.title("Embedding without resolvable dimensions -> 400 EMBEDDING_DIMENSIONS_REQUIRED")
def test_embedding_requires_dimensions(
    ready_project, platform_client: PlatformClient
) -> None:
    resources, prefix = ready_project
    cred = platform_client.config_post(
        f"{prefix}/credentials",
        {
            "name": unique_name("e2e-embed-cred"),
            "provider": "openai_compatible",
            "secretData": {"api_key": "dummy"},
        },
    )
    assert cred.status_code == 201, cred.text
    resources.credential_id = cred.json()["id"]

    resp = platform_client.config_post(
        f"{prefix}/models",
        {
            "name": unique_name("m-embed"),
            "provider": "openai_compatible",
            "credentialId": resources.credential_id,
            "providerModelId": "totally-unknown-embedding-model-xyz",
            "modelType": "embedding",
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json().get("code") == "EMBEDDING_DIMENSIONS_REQUIRED", resp.text


@allure.title("Duplicate model name -> 409")
def test_duplicate_name_conflict(ready_project, platform_client: PlatformClient) -> None:
    _, prefix = ready_project
    # A seeded built-in already occupies its name; re-using it trips the
    # duplicate pre-check before any gateway call.
    embed = platform_client.config_get(f"{prefix}/models?modelType=embedding")
    assert embed.status_code == 200, embed.text
    builtins = [m for m in embed.json() if m.get("isBuiltin")]
    assert builtins, "no built-in models to derive a duplicate name from"
    existing_name = builtins[0]["name"]

    resp = platform_client.config_post(f"{prefix}/models", {"name": existing_name})
    assert resp.status_code == 409, f"expected 409, got {resp.status_code}: {resp.text}"
