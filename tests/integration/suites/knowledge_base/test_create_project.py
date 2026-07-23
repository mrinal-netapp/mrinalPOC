"""Smoke: user login (password grant) and project creation."""

from __future__ import annotations

import pytest

from lib.utils.cleanup import PipelineResources

pytestmark = pytest.mark.smoke


def test_create_project_with_user_credentials(created_project: PipelineResources) -> None:
    assert created_project.project_id
    print(
        f"\nCreated project id={created_project.project_id} "
        f"home_dir={created_project.project_home_dir}"
    )
