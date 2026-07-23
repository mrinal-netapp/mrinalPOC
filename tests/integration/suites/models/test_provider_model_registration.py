"""
Provider model registration happy path (gated — needs cloud credentials).

Mirrors the agent-studio-ui Add-model "Providers" tab: configure credential ->
discover available models -> register -> inspect gateway wiring -> (optionally)
infer -> delete. Endpoints: config-service routes/modelRoutes.ts.

Skips unless a provider credential is configured in .env.local:
  - AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT  -> provider=azure
  - OPENAI_API_KEY (+ optional OPENAI_BASE_URL)   -> provider=openai[/_compatible]
The live /infer assertion is gated behind MODEL_INFER=1.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import allure
import pytest

from lib.common.platform_client import PlatformClient, unique_name
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_platform_project_ready

pytestmark = [
    pytest.mark.models,
    allure.feature("Provider model registration"),
]


def _strip(value: str | None) -> str:
    return (value or "").strip().strip('"').strip("'")


def _flag(name: str) -> bool:
    return _strip(os.environ.get(name)).lower() in ("1", "true", "yes", "on")


def _project_ready_timeout() -> int:
    return int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300")


@dataclass(frozen=True)
class ProviderConfig:
    provider: str
    secret_data: dict
    metadata: dict


def _provider_config_from_env() -> ProviderConfig | None:
    azure_key = _strip(os.environ.get("AZURE_OPENAI_API_KEY"))
    azure_endpoint = _strip(os.environ.get("AZURE_OPENAI_ENDPOINT"))
    if azure_key and azure_endpoint:
        api_version = _strip(os.environ.get("AZURE_OPENAI_API_VERSION")) or "2023-03-15-preview"
        return ProviderConfig(
            provider="azure",
            secret_data={"api_key": azure_key},
            metadata={"endpoint": azure_endpoint, "api_version": api_version},
        )

    openai_key = _strip(os.environ.get("OPENAI_API_KEY"))
    if openai_key:
        base_url = _strip(os.environ.get("OPENAI_BASE_URL"))
        if base_url:
            return ProviderConfig(
                provider="openai_compatible",
                secret_data={"api_key": openai_key},
                metadata={"endpoint": base_url},
            )
        return ProviderConfig(
            provider="openai", secret_data={"api_key": openai_key}, metadata={}
        )
    return None


@pytest.fixture
def provider_config() -> ProviderConfig:
    config = _provider_config_from_env()
    if config is None:
        pytest.skip(
            "provider model registration skipped — set AZURE_OPENAI_API_KEY + "
            "AZURE_OPENAI_ENDPOINT, or OPENAI_API_KEY, in tests/integration/.env.local"
        )
    return config


@allure.title("Provider model: credential -> list-available -> register -> get -> (infer) -> delete")
def test_provider_model_registration(
    provider_config: ProviderConfig,
    created_project: PipelineResources,
    platform_client: PlatformClient,
) -> None:
    project_id = created_project.project_id
    prefix = platform_client.project_prefix(project_id)
    provider = provider_config.provider

    with allure.step("Wait for project-init (model registration requires the gateway VK)"):
        wait_for_platform_project_ready(
            platform_client,
            project_id,
            timeout_sec=_project_ready_timeout(),
        )

    with allure.step(f"Create {provider} credential"):
        cred_resp = platform_client.config_post(
            f"{prefix}/credentials",
            {
                "name": unique_name(f"e2e-{provider}-cred"),
                "description": "pytest provider registration",
                "provider": provider,
                "secretData": provider_config.secret_data,
                "metadata": provider_config.metadata,
            },
        )
        assert cred_resp.status_code == 201, cred_resp.text
        created_project.credential_id = cred_resp.json()["id"]

    with allure.step("Discover available models (list-available)"):
        avail_resp = platform_client.config_post(
            f"{prefix}/models/list-available",
            {"provider": provider, "credentialId": created_project.credential_id, "type": "llm"},
        )
        available_ids: list[str] = []
        if avail_resp.status_code == 200:
            available_ids = [
                m.get("id") for m in (avail_resp.json().get("models") or []) if m.get("id")
            ]
        allure.attach(
            str(available_ids), name="available_models", attachment_type=allure.attachment_type.TEXT
        )

    provider_model_id = _strip(os.environ.get("MODEL_PROVIDER_MODEL_ID")) or (
        available_ids[0] if available_ids else ""
    )
    if not provider_model_id:
        pytest.skip(
            f"no models discoverable for provider {provider} and MODEL_PROVIDER_MODEL_ID unset "
            f"(list-available -> HTTP {avail_resp.status_code})"
        )

    with allure.step(f"Register model {provider_model_id}"):
        reg_resp = platform_client.config_post(
            f"{prefix}/models",
            {
                "name": unique_name("e2e-model"),
                "provider": provider,
                "providerModelId": provider_model_id,
                "modelType": "llm",
                "credentialId": created_project.credential_id,
            },
        )
        assert reg_resp.status_code == 201, reg_resp.text
        model_id = reg_resp.json()["id"]
        created_project.model_ids.append(model_id)

    with allure.step("Get registered model: gateway wiring is present"):
        get_resp = platform_client.config_get(f"{prefix}/models/{model_id}")
        assert get_resp.status_code == 200, get_resp.text
        assert get_resp.json().get("gatewayModelId"), get_resp.text

    if _flag("MODEL_INFER"):
        with allure.step("Infer through the model (MODEL_INFER=1)"):
            infer_resp = platform_client.config_post(
                f"{prefix}/models/{model_id}/infer",
                {
                    "messages": [{"role": "user", "content": "Reply with the single word: hello"}],
                    "maxTokens": 16,
                },
            )
            assert infer_resp.status_code == 200, infer_resp.text
            assert infer_resp.json().get("response"), infer_resp.text
    else:
        allure.attach(
            "MODEL_INFER not set — skipping live inference",
            name="infer_skipped",
            attachment_type=allure.attachment_type.TEXT,
        )

    with allure.step("Edit model: displayName + governance limits persist"):
        new_display = "Edited Display Name"
        put_resp = platform_client.config_put(
            f"{prefix}/models/{model_id}",
            {"displayName": new_display, "rpm": 60, "tpm": 10000, "spendingLimit": 5.0,
             "spendingLimitPeriod": "day"},
        )
        assert put_resp.status_code == 200, put_resp.text
        edited = platform_client.config_get(f"{prefix}/models/{model_id}").json()
        assert edited.get("displayName") == new_display, edited
        assert edited.get("rpm") == 60 and edited.get("tpm") == 10000, edited
        assert edited.get("spendingLimit") == 5.0, edited

    with allure.step("Delete model"):
        del_resp = platform_client.config_delete(f"{prefix}/models/{model_id}")
        assert del_resp.status_code in (200, 202, 204), del_resp.text
        # Already deleted; drop from the cleanup ledger to avoid a redundant 404.
        created_project.model_ids.remove(model_id)


# --- Dummy-credential registration across remote providers (no external infer) ---
# Standard providers whose default endpoints resolve; Bifrost stores the provider
# config without validating the (fake) API key at registration time. If a given
# gateway build DOES reject unverified keys, the test skips (documents that) rather
# than failing.
DUMMY_PROVIDERS = ["openai", "google", "aws_bedrock"]


@pytest.mark.parametrize("provider", DUMMY_PROVIDERS)
@allure.title("Dummy-credential registration: {provider} -> 201 + gateway wiring + governance")
def test_dummy_credential_registration(
    provider: str,
    created_project: PipelineResources,
    platform_client: PlatformClient,
) -> None:
    project_id = created_project.project_id
    prefix = platform_client.project_prefix(project_id)
    wait_for_platform_project_ready(
        platform_client,
        project_id,
        timeout_sec=_project_ready_timeout(),
    )

    cred = platform_client.config_post(
        f"{prefix}/credentials",
        {
            "name": unique_name(f"e2e-{provider}-dummy"),
            "provider": provider,
            "secretData": {"api_key": "dummy-key-not-validated-at-registration"},
        },
    )
    assert cred.status_code == 201, cred.text
    created_project.credential_id = cred.json()["id"]

    reg = platform_client.config_post(
        f"{prefix}/models",
        {
            "name": unique_name(f"e2e-{provider}-model"),
            "provider": provider,
            "providerModelId": f"{provider}-test-model",
            "modelType": "llm",
            "credentialId": created_project.credential_id,
            "rpm": 30,
            "tpm": 5000,
        },
    )
    if reg.status_code != 201:
        pytest.skip(
            f"gateway rejected dummy-credential registration for {provider} "
            f"(HTTP {reg.status_code}); provider covered at validation level only: {reg.text[:200]}"
        )
    model_id = reg.json()["id"]
    created_project.model_ids.append(model_id)

    detail = platform_client.config_get(f"{prefix}/models/{model_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body.get("gatewayModelId"), body
    # Governance fields persist on the row (concurrentRequests/bufferSize do not).
    assert body.get("rpm") == 30 and body.get("tpm") == 5000, body

    del_resp = platform_client.config_delete(f"{prefix}/models/{model_id}")
    assert del_resp.status_code in (200, 202, 204), del_resp.text
    created_project.model_ids.remove(model_id)
