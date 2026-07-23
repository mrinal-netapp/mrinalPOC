"""Shared prerequisites for data-management integration suites.

Fixtures compose in layers so each make target is independent:

  dm_project_prereq     → project + Keycloak RBAC + service account
  dm_credential_prereq  → project + credential (for datasource / dataset suites)
  dm_datasource_prereq  → project + credential + datasource (for dataset suites)

Credential lifecycle tests use ``dm_project_prereq`` only and create credentials
inside the suite. Datasource tests consume ``dm_credential_prereq`` without
running credential tests first.
"""

from __future__ import annotations

import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.prerequisites import (
    require_provider,
    resolve_primary_provider,
    setup_credential_prerequisite,
    setup_datasource_prerequisite,
    setup_project_prerequisite,
)
from lib.utils.cleanup import PipelineResources
from lib.utils.object_store_client import object_store_from_s3_settings


@pytest.fixture
def dm_provider(integration_settings: IntegrationSettings) -> str:
    """Primary connector provider for this environment."""
    provider = resolve_primary_provider(integration_settings)
    if not provider:
        pytest.skip(
            "No connector provider configured — set POSTGRES_*, S3_*, ONTAP_*, "
            "GCP_*, or AZURE_* in .env.local"
        )
    return provider


@pytest.fixture
def dm_project_prereq(
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
    e2e_resources: PipelineResources,
    request: pytest.FixtureRequest,
) -> str:
    """Project + RBAC bootstrap (prerequisite for credential and below)."""
    label = getattr(request, "param", "dm")
    return setup_project_prerequisite(
        platform_client,
        integration_settings,
        e2e_resources,
        label=label,
        metadata={"source": "pytest-data-management"},
    )


@pytest.fixture
def dm_credential_prereq(
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
    e2e_resources: PipelineResources,
    dm_project_prereq: str,
    request: pytest.FixtureRequest,
) -> str:
    """Project + credential (prerequisite for datasource and dataset suites)."""
    provider = getattr(request, "param", None) or resolve_primary_provider(
        integration_settings
    )
    if not provider:
        pytest.skip("No connector provider configured in .env.local")
    require_provider(integration_settings, provider)
    label = provider.replace("_", "-")
    setup_credential_prerequisite(
        platform_client,
        integration_settings,
        e2e_resources,
        dm_project_prereq,
        provider=provider,
        label=label,
    )
    return dm_project_prereq


@pytest.fixture
def dm_datasource_prereq(
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
    e2e_resources: PipelineResources,
    dm_project_prereq: str,
    request: pytest.FixtureRequest,
) -> str:
    """Project + credential + datasource (prerequisite for dataset suites).

    Credential and datasource both use this fixture's ``request.param``. Do not
    chain ``dm_credential_prereq`` here — that fixture has its own ``request`` and
    would default to ``resolve_primary_provider()`` (postgresql when Postgres is
    configured), leaving an S3 datasource bound to the wrong credential type.
    """
    provider = getattr(request, "param", None) or resolve_primary_provider(
        integration_settings
    )
    if not provider:
        pytest.skip("No connector provider configured in .env.local")
    require_provider(integration_settings, provider)
    label = provider.replace("_", "-")
    setup_credential_prerequisite(
        platform_client,
        integration_settings,
        e2e_resources,
        dm_project_prereq,
        provider=provider,
        label=label,
    )
    store = (
        object_store_from_s3_settings(integration_settings)
        if provider == "s3"
        else None
    )
    setup_datasource_prerequisite(
        platform_client,
        integration_settings,
        e2e_resources,
        dm_project_prereq,
        provider=provider,
        label=label,
        store=store,
    )
    return dm_project_prereq
