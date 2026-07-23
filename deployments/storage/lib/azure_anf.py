"""Azure ANF Trident storage reconcile."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(LIB_DIR))
sys.path.insert(0, str(LIB_DIR.parent.parent / "_lib"))

import env_yaml  # noqa: E402
from kubeconfig import kubeconfig_azure  # noqa: E402
from reconcile import (  # noqa: E402
    ReconcileError,
    die,
    ensure_storageclass,
    install_trident_helm,
    kubectl_apply_yaml,
    log,
    run,
    verify_cluster,
    wait_tbc_success,
    _wait_service_account,
    _wait_trident_controller,
)
from render import render_template  # noqa: E402
from smoke import smoke_test_storageclass  # noqa: E402


def _az_json(args: list[str]) -> str:
    result = run(["az", *args], capture=True)
    return (result.stdout or "").strip()


def _parse_kubelet_identity(resource_id: str) -> tuple[str, str]:
    """Return (MC resource group name, user-assigned identity name) from kubelet resourceId."""
    parts = [p for p in resource_id.split("/") if p]
    try:
        rg_idx = parts.index("resourcegroups") + 1
        id_idx = parts.index("userAssignedIdentities") + 1
    except ValueError as exc:
        raise ReconcileError(f"unexpected kubelet identity resourceId: {resource_id}") from exc
    return parts[rg_idx], parts[id_idx]


def _ensure_kubelet_federated_credential(rg: str, cluster: str, trident_ns: str, ksa: str) -> None:
    """Federate the AKS kubelet UAMI to the Trident controller service account."""
    resource_id = _az_json(
        [
            "aks",
            "show",
            "-g",
            rg,
            "-n",
            cluster,
            "--query",
            "identityProfile.kubeletidentity.resourceId",
            "-o",
            "tsv",
        ]
    )
    oidc_issuer = _az_json(
        ["aks", "show", "-g", rg, "-n", cluster, "--query", "oidcIssuerProfile.issuerUrl", "-o", "tsv"]
    )
    if not resource_id or not oidc_issuer:
        raise ReconcileError("AKS kubelet identity or OIDC issuer not available — enable workload identity on the cluster")

    mc_rg, identity_name = _parse_kubelet_identity(resource_id)
    fedcred_name = "trident-controller"
    subject = f"system:serviceaccount:{trident_ns}:{ksa}"

    try:
        run(
            [
                "az",
                "identity",
                "federated-credential",
                "show",
                "--identity-name",
                identity_name,
                "--resource-group",
                mc_rg,
                "--name",
                fedcred_name,
            ],
            capture=True,
        )
        log(f"federated-credential/{fedcred_name} already exists on kubelet identity {identity_name}")
        return
    except subprocess.CalledProcessError:
        pass

    log(f"creating federated-credential/{fedcred_name} on {identity_name} subject={subject}")
    run(
        [
            "az",
            "identity",
            "federated-credential",
            "create",
            "--identity-name",
            identity_name,
            "--resource-group",
            mc_rg,
            "--name",
            fedcred_name,
            "--issuer",
            oidc_issuer,
            "--subject",
            subject,
            "--audience",
            "api://AzureADTokenExchange",
        ]
    )


def _configure_trident_azure_workload_identity(
    namespace: str, kubelet_client_id: str, ksa: str
) -> None:
    """Patch TridentOrchestrator for Azure WI and annotate the controller SA."""
    cloud_identity = f"azure.workload.identity/client-id: {kubelet_client_id}"
    patch = json.dumps({"spec": {"cloudProvider": "Azure", "cloudIdentity": cloud_identity}})
    run(["kubectl", "patch", "tridentorchestrator", "trident", "-n", namespace, "--type", "merge", "-p", patch])

    # Operator creates trident-controller SA/deployment after reconciling the orchestrator CR.
    _wait_service_account(ksa, namespace)
    run(
        [
            "kubectl",
            "annotate",
            "serviceaccount",
            ksa,
            "-n",
            namespace,
            f"azure.workload.identity/client-id={kubelet_client_id}",
            "--overwrite",
        ]
    )
    _wait_trident_controller(namespace)
    run(["kubectl", "rollout", "restart", "deploy/trident-controller", "-n", namespace], check=False)
    run(["kubectl", "rollout", "status", "deploy/trident-controller", "-n", namespace, "--timeout=300s"])


def resolve_export_cidrs(rg: str, cluster: str) -> str:
    subnet_ids = _az_json(
        [
            "aks",
            "show",
            "-g",
            rg,
            "-n",
            cluster,
            "--query",
            "agentPoolProfiles[*].vnetSubnetId",
            "-o",
            "tsv",
        ]
    ).split()
    cidrs: list[str] = []
    for subnet_id in subnet_ids:
        if not subnet_id:
            continue
        cidr = _az_json(["network", "vnet", "subnet", "show", "--ids", subnet_id, "--query", "addressPrefix", "-o", "tsv"])
        if not cidr:
            cidr = _az_json(
                ["network", "vnet", "subnet", "show", "--ids", subnet_id, "--query", "addressPrefixes[0]", "-o", "tsv"]
            )
        if not cidr:
            raise ReconcileError(f"could not resolve CIDR for subnet {subnet_id}")
        cidrs.append(cidr)
    if not cidrs:
        raise ReconcileError("no subnet CIDRs resolved for node pools")
    return ";".join(cidrs)


def main() -> None:
    parser = argparse.ArgumentParser(description="Azure ANF storage reconcile")
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    root = env_yaml.load_path(args.env_file)
    trident = env_yaml.storage_trident(root)
    anf_cfg = (root.get("storage") or {}).get("anf") or {}

    subscription = root["subscriptionId"]
    rg = root["resourceGroup"]
    location = root["location"]
    cluster = root["aks"]["clusterName"]
    anf_account = root["anf"]["anfAccountName"]
    anf_pool = root["anf"]["pools"][0]["name"]
    anf_pool_service_level = str(root["anf"]["pools"][0].get("serviceLevel", "Standard"))
    vnet = root["networking"]["vnetName"]
    anf_subnet = root["networking"]["anfSubnetName"]
    backend = env_yaml.pick(anf_cfg.get("backendName"), default="anf-backend-nfs")
    sc_name = env_yaml.pick(anf_cfg.get("storageClassName"), default="anf-nfs")
    mark_default = str(env_yaml.pick(anf_cfg.get("markAsDefault"), default=False)).lower()

    log(f"azure env={root.get('env')} cluster={cluster}")
    kubeconfig_azure(args.env_file)
    verify_cluster()

    run(["az", "account", "set", "--subscription", subscription])
    tenant = _az_json(["account", "show", "--query", "tenantId", "-o", "tsv"])
    kubelet_client_id = _az_json(
        ["aks", "show", "-g", rg, "-n", cluster, "--query", "identityProfile.kubeletidentity.clientId", "-o", "tsv"]
    )
    if not kubelet_client_id:
        die("could not resolve kubelet managed identity clientId")

    export_cidrs = resolve_export_cidrs(rg, cluster)
    log(f"kubelet_client_id={kubelet_client_id} export_cidrs={export_cidrs}")

    ksa = trident["service_account"]
    _ensure_kubelet_federated_credential(rg, cluster, trident["namespace"], ksa)
    install_trident_helm(
        trident["namespace"],
        trident["helm_version"],
        extra_args=["--set", "cloudProvider=Azure"],
    )
    _configure_trident_azure_workload_identity(trident["namespace"], kubelet_client_id, ksa)

    tbc_yaml = render_template(
        "azure/anf-tbc.yaml.tpl",
        {
            "BACKEND_NAME": backend,
            "TRIDENT_NAMESPACE": trident["namespace"],
            "SUBSCRIPTION_ID": subscription,
            "TENANT_ID": tenant,
            "LOCATION": location,
            "KUBELET_CLIENT_ID": kubelet_client_id,
            "RESOURCE_GROUP": rg,
            "ANF_ACCOUNT": anf_account,
            "ANF_POOL": anf_pool,
            "ANF_SERVICE_LEVEL": anf_pool_service_level,
            "VNET_NAME": vnet,
            "ANF_SUBNET": anf_subnet,
            "EXPORT_CIDRS": export_cidrs,
        },
    )
    kubectl_apply_yaml(tbc_yaml, f"TridentBackendConfig/{backend}")
    wait_tbc_success(backend, trident["namespace"])

    sc_yaml = render_template(
        "azure/anf-sc.yaml.tpl",
        {
            "STORAGE_CLASS_NAME": sc_name,
            "MARK_AS_DEFAULT": mark_default,
        },
    )
    ensure_storageclass(sc_name, sc_yaml, volume_binding_mode="Immediate", reclaim_policy="Delete")

    smoke_test_storageclass(
        sc_name,
        namespace=trident["namespace"],
        access_mode="ReadWriteMany",
        size="100Gi",
        pvc_wait_attempts=120,
    )

    log(f"done: StorageClass/{sc_name} TBC/{backend} Success")
    print(f"  kubectl get tbc -n {trident['namespace']}")
    print(f"  kubectl get storageclass {sc_name}")


if __name__ == "__main__":
    try:
        main()
    except ReconcileError as exc:
        die(str(exc))
    except subprocess.CalledProcessError as exc:
        die(f"command failed: {exc}")
