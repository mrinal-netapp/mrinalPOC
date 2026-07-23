"""Model provisioning via config-service (credential + model).

Config-service rejects an Azure model unless it references a credential
(``credentialId is required for provider azure``). This module implements the
two-step flow end to end:

    1. create the Azure credential   (POST .../credentials)
    2. add the model referencing it   (POST .../models with credentialId)

All HTTP calls go through ``ConfigServiceClient``. The public entry point is
``ModelProvisioner.add_model(ModelConfiguration)``; credential values are read
from the environment via ``ModelConfiguration.from_env``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable, Optional

import httpx

from lib.config_service.client import ConfigServiceClient

# Callback signature used to log a request/response exchange (method, url, body, resp).
ExchangeHook = Callable[[str, str, Optional[object], httpx.Response], None]


class ModelProvisioningError(RuntimeError):
    """Raised when credential or model creation does not return ``201``."""


def _strip(value: str | None) -> str:
    if not value:
        return ""
    return value.strip().strip('"').strip("'")


@dataclass(frozen=True)
class ModelConfiguration:
    """Inputs for provisioning a single (Azure) model + its credential.

    Provider/model identity is supplied by the caller; the credential secrets
    (``api_key``/``endpoint``/``api_version``) are sourced from the environment
    via :meth:`from_env`.
    """

    project_id: str
    provider: str
    model_name: str
    api_key: str
    endpoint: str
    api_version: str = "2023-03-15-preview"
    model_type: str = "llm"
    model_class: str = "balanced"
    credential_name: str = "azure-openai"

    @classmethod
    def from_env(
        cls,
        *,
        project_id: str,
        provider: str,
        model_name: str,
    ) -> ModelConfiguration:
        """Build a config, reading Azure credential secrets from the environment.

        Function use:
            Reads ``AZURE_OPENAI_API_KEY``, ``AZURE_OPENAI_ENDPOINT`` and
            ``AZURE_OPENAI_API_VERSION`` (defaults to ``2023-03-15-preview``) and
            raises a clear error when the api key or endpoint is missing.

        Input:
            project_id (str): The config-service project identifier.
            provider (str): The provider identifier (e.g. ``azure``).
            model_name (str): The model name and provider model id.

        Output:
            ModelConfiguration: A frozen config populated with env-sourced
                credential secrets.
        """
        api_key = _strip(os.environ.get("AZURE_OPENAI_API_KEY"))
        endpoint = _strip(os.environ.get("AZURE_OPENAI_ENDPOINT"))
        api_version = _strip(os.environ.get("AZURE_OPENAI_API_VERSION")) or "2023-03-15-preview"

        missing = [
            name
            for name, value in (
                ("AZURE_OPENAI_API_KEY", api_key),
                ("AZURE_OPENAI_ENDPOINT", endpoint),
            )
            if not value
        ]
        if missing:
            raise ModelProvisioningError(
                "Missing Azure credential env vars: "
                f"{', '.join(missing)}. Set them in tests/integration/.env.local."
            )

        return cls(
            project_id=project_id,
            provider=provider,
            model_name=model_name,
            api_key=api_key,
            endpoint=endpoint,
            api_version=api_version,
        )

    def secret_data(self) -> dict[str, Any]:
        """Return the secret payload for the credential.

        Function use:
            Provides the secret portion of the credential request body
            (the Azure api key).

        Input:
            None

        Output:
            dict[str, Any]: A mapping containing the ``api_key``.
        """
        return {"api_key": self.api_key}

    def metadata(self) -> dict[str, Any]:
        """Return non-secret credential metadata.

        Function use:
            Provides the non-secret metadata for the credential request body
            (endpoint and api version).

        Input:
            None

        Output:
            dict[str, Any]: A mapping with ``endpoint`` and ``api_version``.
        """
        return {"endpoint": self.endpoint, "api_version": self.api_version}

    def model_body(self, credential_id: str) -> dict[str, Any]:
        """Build the ``CreateModelRequest`` body referencing the credential.

        Function use:
            Assembles the create-model request body, linking the model to the
            previously created credential via ``credentialId``.

        Input:
            credential_id (str): The id of the credential the model references.

        Output:
            dict[str, Any]: The create-model request body (camelCase).
        """
        return {
            "name": self.model_name,
            "provider": self.provider,
            "providerModelId": self.model_name,
            "modelType": self.model_type,
            "modelClass": self.model_class,
            "credentialId": credential_id,
        }


class ModelProvisioner:
    """Provisions a model (credential first) via ``ConfigServiceClient``."""

    def __init__(
        self,
        config_client: ConfigServiceClient,
        *,
        on_exchange: ExchangeHook | None = None,
    ) -> None:
        self._client = config_client
        self._on_exchange = on_exchange

    def _log(
        self, method: str, url: str, body: object | None, resp: httpx.Response
    ) -> None:
        if self._on_exchange is not None:
            self._on_exchange(method, url, body, resp)

    def create_credential(self, config: ModelConfiguration) -> str:
        """Step 1: create the Azure credential; return its id.

        Function use:
            Creates the credential via the config-service client, logs the
            exchange, and validates the response, raising on failure.

        Input:
            config (ModelConfiguration): The model/credential configuration.

        Output:
            str: The id of the newly created credential.
        """
        body = ConfigServiceClient.credential_body(
            name=config.credential_name,
            provider=config.provider,
            secret_data=config.secret_data(),
            metadata=config.metadata(),
        )
        resp = self._client.create_model_credential(
            config.project_id,
            name=config.credential_name,
            provider=config.provider,
            secret_data=config.secret_data(),
            metadata=config.metadata(),
        )
        self._log("POST", self._client.credentials_url(config.project_id), body, resp)
        if resp.status_code != 201:
            raise ModelProvisioningError(
                f"Credential creation failed (HTTP {resp.status_code}): {resp.text}"
            )
        credential_id = resp.json().get("id", "")
        if not credential_id:
            raise ModelProvisioningError("Credential response missing 'id'")
        return credential_id

    def register_model(self, config: ModelConfiguration, credential_id: str) -> str:
        """Step 2: add the model referencing ``credential_id``; return model id.

        Function use:
            Registers the model via the config-service client, logs the
            exchange, and validates the response, raising on failure.

        Input:
            config (ModelConfiguration): The model configuration.
            credential_id (str): The id of the credential the model references.

        Output:
            str: The id of the newly registered model.
        """
        body = config.model_body(credential_id)
        resp = self._client.add_model(config.project_id, body)
        self._log("POST", self._client.models_url(config.project_id), body, resp)
        if resp.status_code != 201:
            raise ModelProvisioningError(
                f"Model creation failed (HTTP {resp.status_code}): {resp.text}"
            )
        model_id = resp.json().get("id", "")
        if not model_id:
            raise ModelProvisioningError("Model response missing 'id'")
        return model_id

    def add_model(self, config: ModelConfiguration) -> str:
        """Create the credential then the model; return the new model id.

        Function use:
            Public entry point that runs the two-step provisioning flow:
            create the credential, then register the model that references it.

        Input:
            config (ModelConfiguration): The model/credential configuration.

        Output:
            str: The id of the newly registered model.
        """
        credential_id = self.create_credential(config)
        return self.register_model(config, credential_id)

    def add_azure_openai_credentials(
        self,
        project_id: str,
        *,
        name: str = "azure-openai",
        provider: str = "azure",
    ) -> str:
        """Create an Azure OpenAI credential from the environment; return its id.

        Function use:
            Reads ``AZURE_OPENAI_API_KEY``, ``AZURE_OPENAI_ENDPOINT`` and
            ``AZURE_OPENAI_API_VERSION`` (defaults to ``2024-06-01``), creates the
            credential via the config-service client, logs the exchange, and
            validates the response.

        Input:
            project_id (str): The config-service project identifier.
            name (str): The credential name (defaults to ``azure-openai``).
            provider (str): The provider identifier (defaults to ``azure``).

        Output:
            str: The id of the newly created credential.
        """
        api_key = _strip(os.environ.get("AZURE_OPENAI_API_KEY"))
        endpoint = _strip(os.environ.get("AZURE_OPENAI_ENDPOINT"))
        api_version = _strip(os.environ.get("AZURE_OPENAI_API_VERSION")) or "2024-06-01"

        missing = [
            var_name
            for var_name, value in (
                ("AZURE_OPENAI_API_KEY", api_key),
                ("AZURE_OPENAI_ENDPOINT", endpoint),
            )
            if not value
        ]
        if missing:
            raise ModelProvisioningError(
                "Missing Azure credential env vars: "
                f"{', '.join(missing)}. Set them in tests/integration/.env.local."
            )

        secret_data = {"api_key": api_key}
        metadata = {"endpoint": endpoint, "api_version": api_version}
        resp = self._client.create_model_credential(
            project_id,
            name=name,
            provider=provider,
            secret_data=secret_data,
            metadata=metadata,
        )
        self._log(
            "POST",
            self._client.credentials_url(project_id),
            ConfigServiceClient.credential_body(
                name=name,
                provider=provider,
                secret_data=secret_data,
                metadata=metadata,
            ),
            resp,
        )
        if resp.status_code != 201:
            raise ModelProvisioningError(
                f"Credential creation failed (HTTP {resp.status_code}): {resp.text}"
            )
        credential_id = resp.json().get("id", "")
        if not credential_id:
            raise ModelProvisioningError("Credential response missing 'id'")
        return credential_id

    def add_llm_models(
        self,
        project_id: str,
        credential_id: str,
        *,
        provider: str = "azure",
        model_type: str = "llm",
        model_class: str = "balanced",
    ) -> str:
        """Register an Azure LLM model from ``$LLM_MODEL_NAME``; return its id.

        Function use:
            Reads ``LLM_MODEL_NAME`` (the Azure deployment name), builds the
            create-model body referencing ``credential_id`` (mapping the
            deployment name onto ``name``/``providerModelId``/
            ``providerDeploymentName``), posts it via the config-service client,
            logs the exchange, and validates the response.

        Input:
            project_id (str): The config-service project identifier.
            credential_id (str): The id of the credential the model references.
            provider (str): The provider identifier (defaults to ``azure``).
            model_type (str): The model type (defaults to ``llm``).
            model_class (str): The model class (defaults to ``balanced``).

        Output:
            str: The id of the newly registered model.
        """
        deployment = _strip(os.environ.get("LLM_MODEL_NAME"))
        if not deployment:
            raise ModelProvisioningError(
                "Missing LLM_MODEL_NAME env var. "
                "Set it in tests/integration/.env.local."
            )
        body = {
            "name": deployment,
            "provider": provider,
            "providerModelId": deployment,
            "providerDeploymentName": deployment,
            "modelType": model_type,
            "modelClass": model_class,
            "credentialId": credential_id,
        }
        resp = self._client.add_model(project_id, body)
        self._log("POST", self._client.models_url(project_id), body, resp)
        if resp.status_code != 201:
            raise ModelProvisioningError(
                f"Model creation failed (HTTP {resp.status_code}): {resp.text}"
            )
        model_id = resp.json().get("id", "")
        if not model_id:
            raise ModelProvisioningError("Model response missing 'id'")
        return model_id
