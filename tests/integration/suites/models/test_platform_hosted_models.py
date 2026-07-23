"""
Platform-hosted model registration happy path (zero external credentials).

"Platform-hosted models" = the built-in TEI embedding models auto-seeded into
every project during project-init (services/BuiltinModels.ts): they are
registered as Model rows (isBuiltin=true, modelType=embedding) and fronted by
Bifrost as `as-tei-*` providers pointing at in-cluster TEI. This suite verifies
that registration completed for a fresh project and that a built-in exposes its
gateway wiring. Live embedding is exercised end-to-end by the KB happy path.

Runs in CI without any cloud credentials.
"""

from __future__ import annotations

import os

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_project_ready

pytestmark = [
    pytest.mark.models,
    allure.feature("Platform-hosted models (built-in TEI)"),
]

# Canonical default from services/BuiltinModels.ts (keep in sync).
DEFAULT_BUILTIN_EMBEDDING = "sentence-transformers/all-MiniLM-L6-v2"


def _project_ready_timeout() -> int:
    return int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300")


@allure.title("Platform-hosted: built-in TEI embedding models seeded + gateway-wired")
def test_platform_hosted_builtin_models(
    created_project: PipelineResources,
    platform_client: PlatformClient,
) -> None:
    project_id = created_project.project_id
    prefix = platform_client.project_prefix(project_id)

    with allure.step("Wait for project-init (built-in models seeded)"):
        wait_for_project_ready(
            lambda: platform_client.config_get(f"{prefix}/models"),
            timeout_sec=_project_ready_timeout(),
        )

    with allure.step("List embedding models: built-ins are registered"):
        resp = platform_client.config_get(f"{prefix}/models?modelType=embedding")
        assert resp.status_code == 200, resp.text
        models = resp.json()
        assert isinstance(models, list) and models, "no embedding models seeded"
        # Every returned model is an embedding model, and the built-ins are marked.
        assert all(m.get("modelType") == "embedding" for m in models), models
        builtins = [m for m in models if m.get("isBuiltin")]
        assert builtins, f"expected isBuiltin embedding models: {models}"

        default = next(
            (m for m in models if m.get("name") == DEFAULT_BUILTIN_EMBEDDING), None
        )
        assert default is not None, (
            f"default built-in {DEFAULT_BUILTIN_EMBEDDING!r} not seeded: "
            f"{[m.get('name') for m in models]}"
        )
        assert default.get("isBuiltin"), default
        assert default.get("providerModelId") == DEFAULT_BUILTIN_EMBEDDING, default
        model_id = default["id"]

    with allure.step("Get built-in model: gateway wiring is present"):
        get_resp = platform_client.config_get(f"{prefix}/models/{model_id}")
        assert get_resp.status_code == 200, get_resp.text
        detail = get_resp.json()
        assert detail.get("gatewayModelId"), detail
        # Built-ins are served by Bifrost as `as-tei-*` custom providers.
        assert str(detail.get("provider", "")).startswith("as-tei"), detail

    with allure.step("List providers"):
        prov_resp = platform_client.config_get(f"{prefix}/providers")
        assert prov_resp.status_code == 200, prov_resp.text
        prov_body = prov_resp.json()
        assert prov_body.get("success") is True, prov_body
        assert isinstance(prov_body.get("providers"), list), prov_body


@allure.title("Built-in models are immutable: only displayName editable; delete rejected")
def test_builtin_model_immutability(
    created_project: PipelineResources,
    platform_client: PlatformClient,
) -> None:
    project_id = created_project.project_id
    prefix = platform_client.project_prefix(project_id)

    with allure.step("Wait for project-init (built-in models seeded)"):
        wait_for_project_ready(
            lambda: platform_client.config_get(f"{prefix}/models"),
            timeout_sec=_project_ready_timeout(),
        )

    resp = platform_client.config_get(f"{prefix}/models?modelType=embedding")
    assert resp.status_code == 200, resp.text
    builtins = [m for m in resp.json() if m.get("isBuiltin")]
    assert builtins, "no built-in models present"
    model_id = builtins[0]["id"]

    with allure.step("PUT a non-displayName field -> 400 BUILTIN_MODEL_IMMUTABLE"):
        bad = platform_client.config_put(f"{prefix}/models/{model_id}", {"rpm": 100})
        assert bad.status_code == 400, bad.text
        assert bad.json().get("code") == "BUILTIN_MODEL_IMMUTABLE", bad.text

    with allure.step("PUT displayName -> 200 (only editable field)"):
        ok = platform_client.config_put(
            f"{prefix}/models/{model_id}", {"displayName": "Built-in (edited label)"}
        )
        assert ok.status_code == 200, ok.text

    with allure.step("DELETE built-in -> 400 (rejected)"):
        deleted = platform_client.config_delete(f"{prefix}/models/{model_id}")
        assert deleted.status_code == 400, deleted.text
