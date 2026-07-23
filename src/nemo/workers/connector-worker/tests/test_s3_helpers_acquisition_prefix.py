"""Unit tests for acquisition_artifact_key_prefix (s3_helpers)."""

from __future__ import annotations

import sys
from pathlib import Path

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from activities.acquisition_store_paths import acquisition_artifact_key_prefix  # noqa: E402


def test_prefers_project_and_dataset_ids():
    assert acquisition_artifact_key_prefix({
        "projectID": "p1",
        "datasetID": "d1",
        "outputPath": "/projects/p1/datasets/d1/data_files",
    }) == "projects/p1/datasets/d1"


def test_strips_data_files_when_ids_absent():
    assert acquisition_artifact_key_prefix({
        "outputPath": "/projects/aa/datasets/bb/data_files",
        "outputBucket": "bucket",
    }) == "projects/aa/datasets/bb"


def test_s3_path_strips_data_files_suffix():
    assert acquisition_artifact_key_prefix({
        "outputS3Path": "s3://mybucket/projects/x/datasets/y/data_files",
    }) == "projects/x/datasets/y"


def test_non_data_files_prefix_unchanged_when_no_ids():
    assert acquisition_artifact_key_prefix({
        "outputPath": "/custom/prefix/without-suffix",
        "outputBucket": "b",
    }) == "custom/prefix/without-suffix"
