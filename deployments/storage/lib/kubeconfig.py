"""Kubeconfig fetch via cloud CLIs."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml

from reconcile import ReconcileError, log, run


def kubeconfig_azure(env_file: Path) -> None:
    root = yaml.safe_load(env_file.read_text(encoding="utf-8")) or {}
    subscription = root["subscriptionId"]
    rg = root["resourceGroup"]
    cluster = root["aks"]["clusterName"]
    run(["az", "account", "set", "--subscription", subscription])
    run(["az", "aks", "get-credentials", "-g", rg, "-n", cluster, "--overwrite-existing"])


def _cf_output(env_file: Path, key: str) -> str:
    root = yaml.safe_load(env_file.read_text(encoding="utf-8")) or {}
    region = root["region"]
    stack = root["stackName"]
    result = run(
        [
            "aws",
            "cloudformation",
            "describe-stacks",
            "--region",
            region,
            "--stack-name",
            stack,
            "--query",
            f"Stacks[0].Outputs[?OutputKey=='{key}'].OutputValue | [0]",
            "--output",
            "text",
        ],
        capture=True,
    )
    value = (result.stdout or "").strip()
    if not value or value == "None":
        raise ReconcileError(f"missing CloudFormation output {key} for stack {stack}")
    return value


def kubeconfig_aws(env_file: Path) -> None:
    root = yaml.safe_load(env_file.read_text(encoding="utf-8")) or {}
    region = root["region"]
    cluster = _cf_output(env_file, "EksClusterName")
    run(["aws", "eks", "update-kubeconfig", "--region", region, "--name", cluster])


def kubeconfig_gke(env_file: Path) -> None:
    root = yaml.safe_load(env_file.read_text(encoding="utf-8")) or {}
    project = root["projectId"]
    location = root["location"]
    cluster = (root.get("gke") or {}).get("clusterName")
    run(
        [
            "gcloud",
            "container",
            "clusters",
            "get-credentials",
            cluster,
            "--region",
            location,
            "--project",
            project,
        ]
    )
