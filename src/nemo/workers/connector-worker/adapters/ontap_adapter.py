"""NetApp ONTAP provider adapter for explorer actions.

Account-scope provider: one connector represents one ONTAP cluster, and the
explorer browses SVMs, volumes, LUNs, snapshots, aggregates and network
interfaces from there, plus a Performance Metrics branch surfacing the
metric categories (volume/aggregate/quotas) that ``AcquireMetrics`` can
collect from Counter Manager.

All errors are mapped to the common ``ExplorerResponse`` envelope; nothing
escapes ``execute()`` as an exception.
"""
from __future__ import annotations

import ipaddress
from observability_client_runtime import get_logger
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

from ontap_common import (
    OntapAuthError,
    OntapClient,
    OntapError,
    OntapHTTPError,
    OntapNetworkError,
    OntapTLSVerifyError,
    OntapTimeoutError,
    verify_tls_from_connector_config,
)

from .base import ExplorerError, ExplorerNode, ExplorerResponse, ProviderAdapter
from .metric_explorer_nodes import ontap_metric_category_nodes

logger = get_logger()


def _extract_default_svm(config: Dict[str, Any]) -> Optional[str]:
    val = config.get("default_svm")
    if isinstance(val, str) and val.strip():
        return val.strip()
    return None


def _extract_client_cidrs(config: Dict[str, Any]) -> List[str]:
    raw = config.get("client_cidrs")
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if isinstance(raw, str) and raw.strip():
        return [p.strip() for p in raw.split(",") if p.strip()]
    return []


def _client_from_config(
    config: Dict[str, Any],
    credential: Dict[str, str],
) -> OntapClient:
    cluster_url = (config.get("cluster_url") or "").strip()
    if not cluster_url:
        raise ValueError("cluster_url is required in connector config")
    verify_tls = verify_tls_from_connector_config(config)
    return OntapClient(cluster_url=cluster_url, credential=credential, verify_tls=verify_tls)


def _ontap_error_to_envelope(exc: Exception) -> ExplorerResponse:
    if isinstance(exc, OntapTLSVerifyError):
        return ExplorerResponse(
            error=ExplorerError("TLS_VERIFY_FAILED", f"{exc.message}. {exc.hint or ''}".strip()),
        )
    if isinstance(exc, OntapAuthError):
        return ExplorerResponse(error=ExplorerError("UNAUTHORIZED", str(exc)))
    if isinstance(exc, OntapTimeoutError):
        return ExplorerResponse(error=ExplorerError("TIMEOUT", str(exc)))
    if isinstance(exc, (OntapNetworkError, OntapHTTPError, OntapError)):
        return ExplorerResponse(error=ExplorerError("PROVIDER_ERROR", str(exc)))
    return ExplorerResponse(error=ExplorerError("PROVIDER_ERROR", str(exc)))


def _truncate_marker(metadata: Dict[str, Any]) -> Dict[str, Any]:
    metadata = dict(metadata)
    metadata["truncated"] = True
    return metadata


def _lif_has_data_nfs(lif: Dict[str, Any]) -> bool:
    """True if this LIF advertises the NFS data service (REST name is usually ``data_nfs``)."""
    services = lif.get("services") or []
    if not isinstance(services, list):
        return False
    for s in services:
        if str(s).lower() in ("data_nfs", "data-nfs"):
            return True
    return False


def _tcp_probe(host: str, port: int = 2049, timeout_s: float = 3.0) -> Dict[str, Any]:
    """TCP reachability to NFS port from this worker pod (not from kubelet)."""
    h = (host or "").strip()
    if not h:
        return {"ok": False, "error": "empty host", "probe_origin": "connector_worker_pod"}
    try:
        with socket.create_connection((h, port), timeout=timeout_s):
            pass
        return {"ok": True, "error": None, "probe_origin": "connector_worker_pod"}
    except OSError as e:
        return {"ok": False, "error": str(e), "probe_origin": "connector_worker_pod"}


def _parse_nfs_protocols(svc: Optional[Dict[str, Any]]) -> Dict[str, bool]:
    if not svc:
        return {"v3": True, "v40": True, "v41": True}
    proto = svc.get("protocol") or {}
    return {
        "v3": bool(proto.get("v3_enabled", True)),
        "v40": bool(proto.get("v40_enabled", False)),
        "v41": bool(proto.get("v41_enabled", False)),
    }


def _suggested_nfs_vers_mount(nfs_protocols: Dict[str, bool]) -> str:
    if nfs_protocols.get("v3"):
        return "vers=3"
    if nfs_protocols.get("v41"):
        return "vers=4.1"
    if nfs_protocols.get("v40"):
        return "vers=4.0"
    return "vers=3"


def _nfs_protocols_enabled(nfs_protocols: Dict[str, bool]) -> bool:
    return bool(nfs_protocols.get("v3") or nfs_protocols.get("v40") or nfs_protocols.get("v41"))


def _svm_nfs_service(
    client: OntapClient,
    svm_uuid: str,
    svm_name: str,
) -> Optional[Dict[str, Any]]:
    """GET NFS service for SVM; includes enabled, state, protocol.*"""
    params: Dict[str, Any] = {
        "fields": "enabled,state,protocol,svm",
    }
    u = (svm_uuid or "").strip()
    n = (svm_name or "").strip()
    if u:
        params["svm.uuid"] = u
    elif n:
        params["svm.name"] = n
    else:
        return None
    try:
        page = client.get_paginated("/api/protocols/nfs/services", params=params, max_records=5)
        if page.records:
            return page.records[0]
    except OntapError:
        logger.debug("NFS service lookup failed for svm uuid=%s name=%s", u, n)
    return None


def _nfs_data_lif_for_svm(
    client: OntapClient,
    svm_uuid: str,
    svm_name: str,
) -> Optional[Dict[str, str]]:
    """Resolve preferred NFS data LIF (address, name, state)."""
    params: Dict[str, Any] = {"fields": "ip,services,state,name"}
    u = (svm_uuid or "").strip()
    n = (svm_name or "").strip()
    if u:
        params["svm.uuid"] = u
    elif n:
        params["svm.name"] = n
    else:
        return None

    page = client.get_paginated(
        "/api/network/ip/interfaces",
        params=params,
        max_records=200,
    )
    lifs = [x for x in page.records if _lif_has_data_nfs(x)]
    if not lifs:
        return None

    def rank(lif: Dict[str, Any]) -> tuple:
        st = (lif.get("state") or "").lower()
        up = 0 if st == "up" else 1
        return (up, lif.get("name") or "")

    lifs.sort(key=rank)
    for lif in lifs:
        addr = (lif.get("ip") or {}).get("address")
        if addr:
            return {
                "address": str(addr).strip(),
                "lif_name": str(lif.get("name") or ""),
                "lif_state": str(lif.get("state") or ""),
            }
    return None


def _count_data_nfs_lifs(client: OntapClient, svm_uuid: str, svm_name: str) -> int:
    params: Dict[str, Any] = {"fields": "ip,services,state,name"}
    u = (svm_uuid or "").strip()
    n = (svm_name or "").strip()
    if u:
        params["svm.uuid"] = u
    elif n:
        params["svm.name"] = n
    else:
        return 0
    page = client.get_paginated("/api/network/ip/interfaces", params=params, max_records=200)
    return len([x for x in page.records if _lif_has_data_nfs(x)])


def _fetch_export_policy_rules(
    client: OntapClient,
    svm_uuid: str,
    policy_name: str,
) -> List[Dict[str, Any]]:
    if not policy_name or not svm_uuid:
        return []
    try:
        page = client.get_paginated(
            "/api/protocols/nfs/export-policies",
            params={
                "svm.uuid": svm_uuid,
                "name": policy_name,
                "fields": "rules,name,uuid",
            },
            max_records=5,
        )
        if not page.records:
            return []
        pol = page.records[0]
        rules = pol.get("rules") or []
        out: List[Dict[str, Any]] = []
        for r in rules if isinstance(rules, list) else []:
            clients = r.get("clients") or []
            matches: List[str] = []
            if isinstance(clients, list):
                for c in clients:
                    if isinstance(c, dict) and c.get("match"):
                        matches.append(str(c["match"]))
                    elif isinstance(c, str):
                        matches.append(c)
            out.append(
                {
                    "clients_match": matches,
                    "protocols": r.get("protocols"),
                    "ro_rule": r.get("ro_rule"),
                    "rw_rule": r.get("rw_rule"),
                    "index": r.get("index"),
                }
            )
        return out
    except OntapError as e:
        logger.debug("export policy rules fetch failed: %s", e)
        return []


def _cidr_matches_rule(client_cidr: str, rule_matches: List[str]) -> bool:
    """Return True if client_cidr overlaps or is contained in any rule match."""
    try:
        net = ipaddress.ip_network(client_cidr, strict=False)
    except ValueError:
        return False
    for m in rule_matches:
        ms = (m or "").strip()
        if not ms:
            continue
        if ms in ("0.0.0.0/0", "::/0"):
            return True
        try:
            if "/" in ms:
                rule_net = ipaddress.ip_network(ms, strict=False)
                if net.version == rule_net.version:
                    if net.overlaps(rule_net) or net.subnet_of(rule_net):
                        return True
            else:
                host = ipaddress.ip_address(ms)
                if host in net:
                    return True
        except ValueError:
            continue
    return False


def _export_policy_allows_client_cidrs(
    rules_summary: List[Dict[str, Any]],
    client_cidrs: List[str],
) -> bool:
    if not client_cidrs:
        return True
    for cidr in client_cidrs:
        allowed = False
        for rule in rules_summary:
            matches = rule.get("clients_match") or []
            if _cidr_matches_rule(cidr, matches):
                allowed = True
                break
        if not allowed:
            return False
    return True


def _build_mount_preflight(
    *,
    svm_state: Optional[str],
    junction_path: Optional[str],
    nfs_lif: Optional[Dict[str, str]],
    nfs_svc: Optional[Dict[str, Any]],
    nfs_protocols: Dict[str, bool],
    tcp: Dict[str, Any],
    export_policy_name: Optional[str],
    export_rules: List[Dict[str, Any]],
    client_cidrs: List[str],
) -> Dict[str, Any]:
    blocking: List[str] = []
    warnings: List[str] = []

    if svm_state and str(svm_state).lower() != "running":
        blocking.append("svm_not_running")

    if not (junction_path and str(junction_path).strip()):
        blocking.append("no_junction_path")

    if not nfs_lif or not nfs_lif.get("address"):
        blocking.append("no_data_nfs_lif")

    if nfs_svc is not None:
        if not nfs_svc.get("enabled", True):
            blocking.append("nfs_service_disabled")
        st = (nfs_svc.get("state") or "").lower()
        if st and st != "online":
            blocking.append("nfs_service_offline")
    else:
        warnings.append("nfs_service_unavailable")

    if not _nfs_protocols_enabled(nfs_protocols):
        blocking.append("no_nfs_protocol_enabled")

    if not tcp.get("ok"):
        blocking.append("tcp_2049_refused")

    if export_policy_name:
        warnings.append(f"export_policy:{export_policy_name}")
    if export_rules and client_cidrs:
        if not _export_policy_allows_client_cidrs(export_rules, client_cidrs):
            blocking.append("export_policy_blocks_node_cidr")

    can_mount = len(blocking) == 0
    return {
        "can_mount": can_mount,
        "blocking": blocking,
        "warnings": warnings,
    }


class OntapAdapter(ProviderAdapter):
    """Provider adapter for NetApp ONTAP clusters."""

    SUPPORTED_ACTIONS = (
        "testConnection",
        "listServices",
        "listSvms",
        "listVolumes",
        "listLuns",
        "listSnapshots",
        "listAggregates",
        "listNetworkInterfaces",
        "listSvmInterfaces",
        "testVolumeMount",
        "testNetworkInterfaceReachability",
        "resolveBestMountForVolume",
        "listMetricCategories",
    )

    # ── Dispatcher ─────────────────────────────────────────────────────────

    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        try:
            if action == "testConnection":
                return self._test_connection(connector_config, credential)
            if action == "listPath":
                return self._list_services(connector_config, credential)
            if action == "listServices":
                return self._list_services(connector_config, credential)
            if action == "listSvms":
                return self._list_svms(connector_config, credential)
            if action == "listVolumes":
                return self._list_volumes(connector_config, credential, payload)
            if action == "listLuns":
                return self._list_luns(connector_config, credential, payload)
            if action == "listSnapshots":
                return self._list_snapshots(connector_config, credential, payload)
            if action == "listAggregates":
                return self._list_aggregates(connector_config, credential)
            if action == "listNetworkInterfaces":
                return self._list_network_interfaces(connector_config, credential, payload)
            if action == "listSvmInterfaces":
                return self._list_svm_interfaces(connector_config, credential, payload)
            if action == "testVolumeMount":
                return self._test_volume_mount(connector_config, credential, payload)
            if action == "testNetworkInterfaceReachability":
                return self._test_network_interface_reachability(connector_config, credential, payload)
            if action == "resolveBestMountForVolume":
                return self._resolve_best_mount_for_volume(connector_config, credential, payload)
            if action == "listMetricCategories":
                return ExplorerResponse(nodes=ontap_metric_category_nodes())
            return ExplorerResponse(
                error=ExplorerError(
                    "UNSUPPORTED_ACTION",
                    f"Action '{action}' not supported by ONTAP adapter",
                ),
            )
        except OntapError as e:
            logger.warning("ONTAP adapter %s failed: %s", action, e)
            return _ontap_error_to_envelope(e)
        except ValueError as e:
            return ExplorerResponse(error=ExplorerError("VALIDATION_ERROR", str(e)))
        except Exception as e:
            logger.exception("ONTAP adapter unexpected error: action=%s", action)
            return ExplorerResponse(error=ExplorerError("PROVIDER_ERROR", str(e)))

    # ── testConnection ─────────────────────────────────────────────────────

    def _test_connection(
        self, config: Dict[str, Any], credential: Dict[str, str]
    ) -> ExplorerResponse:
        with _client_from_config(config, credential) as client:
            cluster = client.get("/api/cluster")
        name = cluster.get("name") or "(unnamed cluster)"
        version_obj = cluster.get("version") or {}
        version = version_obj.get("full") or version_obj.get("generation") or ""
        node = ExplorerNode(
            id=f"ontap:cluster/{name}",
            label=name,
            type="service",
            kind="cluster",
            children_hint="hasChildren",
            resource={"cluster": name},
            metadata={"version": version},
        )
        return ExplorerResponse(nodes=[node])

    # ── listServices ───────────────────────────────────────────────────────

    def _list_services(
        self, config: Dict[str, Any], credential: Dict[str, str]
    ) -> ExplorerResponse:
        default_svm = _extract_default_svm(config)
        nodes: List[ExplorerNode] = []
        if default_svm:
            nodes.append(
                ExplorerNode(
                    id=f"ontap:svc/svm/{default_svm}",
                    label=f"SVM ({default_svm})",
                    type="service",
                    kind="svm",
                    children_hint="hasChildren",
                    resource={"service": "svm", "default_svm": default_svm},
                    actions=["listVolumes", "listLuns", "listSvmInterfaces"],
                )
            )
        else:
            nodes.append(
                ExplorerNode(
                    id="ontap:svc/svms",
                    label="Storage VMs (SVMs)",
                    type="service",
                    kind="svms",
                    children_hint="hasChildren",
                    resource={"service": "svms"},
                    actions=["listSvms"],
                )
            )

        # Performance Metrics branch — surfaces metric categories acquired via
        # AcquireMetrics. Synthetic; no live ONTAP call needed to enumerate.
        nodes.append(
            ExplorerNode(
                id="ontap:svc/metrics",
                label="Performance Metrics",
                type="service",
                kind="metrics",
                children_hint="hasChildren",
                resource={"service": "metrics"},
                actions=["listMetricCategories"],
            )
        )
        return ExplorerResponse(nodes=nodes)

    def _enrich_svm_node_metadata(
        self, config: Dict[str, Any], credential: Dict[str, str], svm: Dict[str, Any]
    ) -> Dict[str, Any]:
        uuid = svm.get("uuid", "") or ""
        name = svm.get("name", "") or ""
        metadata: Dict[str, Any] = {
            "state": svm.get("state"),
            "ipspace": (svm.get("ipspace") or {}).get("name"),
            "language": svm.get("language"),
        }
        try:
            with _client_from_config(config, credential) as client:
                nfs_lif = _nfs_data_lif_for_svm(client, uuid, name)
                nfs_svc = _svm_nfs_service(client, uuid, name)
                nfs_protocols = _parse_nfs_protocols(nfs_svc)
                data_lif_count = _count_data_nfs_lifs(client, uuid, name)
                tcp: Dict[str, Any] = {"ok": True, "error": None, "probe_origin": "connector_worker_pod"}
                if nfs_lif and nfs_lif.get("address"):
                    tcp = _tcp_probe(nfs_lif["address"])
                metadata["nfs_protocols"] = nfs_protocols
                metadata["data_lif_count"] = data_lif_count
                if nfs_lif:
                    metadata["nfs_data_lif"] = nfs_lif["address"]
                    metadata["nfs_data_lif_name"] = nfs_lif.get("lif_name", "")
                    metadata["nfs_data_lif_state"] = nfs_lif.get("lif_state", "")
                if nfs_svc:
                    metadata["nfs_service_enabled"] = nfs_svc.get("enabled")
                    metadata["nfs_service_state"] = nfs_svc.get("state")
                metadata["tcp_2049"] = tcp
                metadata["tcp_2049_ok"] = tcp.get("ok")
                metadata["tcp_2049_error"] = tcp.get("error")
        except Exception as e:
            logger.debug("SVM enrich failed for %s: %s", name, e)
            metadata["svm_enrich_error"] = str(e)
        return metadata

    # ── listSvms ───────────────────────────────────────────────────────────

    def _list_svms(
        self, config: Dict[str, Any], credential: Dict[str, str]
    ) -> ExplorerResponse:
        default_svm = _extract_default_svm(config)
        params: Dict[str, Any] = {
            "fields": "uuid,name,state,ipspace,language",
        }
        if default_svm:
            params["name"] = default_svm

        with _client_from_config(config, credential) as client:
            page = client.get_paginated("/api/svm/svms", params=params)

        svm_records = list(page.records)
        enriched: Dict[int, Dict[str, Any]] = {}
        max_workers = min(8, max(1, len(svm_records)))

        def _work(idx: int, svm: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
            meta = self._enrich_svm_node_metadata(config, credential, svm)
            return idx, meta

        if svm_records:
            with ThreadPoolExecutor(max_workers=max_workers) as ex:
                futs = [ex.submit(_work, i, svm) for i, svm in enumerate(svm_records)]
                for fut in as_completed(futs):
                    idx, meta = fut.result()
                    enriched[idx] = meta

        nodes: List[ExplorerNode] = []
        for idx, svm in enumerate(svm_records):
            uuid = svm.get("uuid", "")
            name = svm.get("name", uuid or f"svm-{idx}")
            metadata: Dict[str, Any] = {
                "state": svm.get("state"),
                "ipspace": (svm.get("ipspace") or {}).get("name"),
                "language": svm.get("language"),
            }
            metadata.update(enriched.get(idx, {}))
            if page.truncated and idx == len(svm_records) - 1:
                metadata = _truncate_marker(metadata)
            nodes.append(
                ExplorerNode(
                    id=f"ontap:svm/{uuid or name}",
                    label=name,
                    type="svm",
                    kind="SVM",
                    children_hint="hasChildren",
                    resource={"svm_uuid": uuid, "svm_name": name},
                    actions=["listVolumes", "listLuns", "listSvmInterfaces"],
                    metadata=metadata,
                )
            )
        return ExplorerResponse(nodes=nodes)

    # ── listVolumes ────────────────────────────────────────────────────────

    def _list_volumes(
        self, config: Dict[str, Any], credential: Dict[str, str], payload: Dict[str, Any]
    ) -> ExplorerResponse:
        svm_uuid = (payload.get("svm_uuid") or "").strip()
        svm_name = (payload.get("svm_name") or "").strip()
        default_svm = _extract_default_svm(config)
        if not svm_uuid and not svm_name:
            if default_svm:
                svm_name = default_svm
            else:
                return ExplorerResponse(
                    error=ExplorerError("VALIDATION_ERROR", "svm_uuid or svm_name is required for listVolumes"),
                )

        params: Dict[str, Any] = {
            "fields": "uuid,name,state,size,space,type,style,svm,aggregates,nas",
        }
        if svm_uuid:
            params["svm.uuid"] = svm_uuid
        else:
            params["svm.name"] = svm_name

        client_cidrs = _extract_client_cidrs(config)

        with _client_from_config(config, credential) as client:
            page = client.get_paginated("/api/storage/volumes", params=params)

            svm0 = (page.records[0].get("svm") if page.records else None) or {}
            eff_uuid = (svm_uuid or svm0.get("uuid") or "").strip()
            eff_name = (svm_name or svm0.get("name") or "").strip()
            svm_state = svm0.get("state") if svm0 else None

            nfs_lif = _nfs_data_lif_for_svm(client, eff_uuid, eff_name)
            nfs_svc = _svm_nfs_service(client, eff_uuid, eff_name)
            nfs_protocols = _parse_nfs_protocols(nfs_svc)
            tcp = (
                _tcp_probe(nfs_lif["address"])
                if nfs_lif and nfs_lif.get("address")
                else {"ok": False, "error": "no lif", "probe_origin": "connector_worker_pod"}
            )

            nodes: List[ExplorerNode] = []
            for idx, vol in enumerate(page.records):
                uuid = vol.get("uuid", "")
                name = vol.get("name", uuid or f"volume-{idx}")
                svm = vol.get("svm") or {}
                space = vol.get("space") or {}
                nas = vol.get("nas") or {}
                aggrs = ",".join((a.get("name") or "") for a in (vol.get("aggregates") or []) if a.get("name"))
                junction = nas.get("path")
                pol_name = (nas.get("export_policy") or {}).get("name") if isinstance(nas.get("export_policy"), dict) else None

                export_rules: List[Dict[str, Any]] = []
                if pol_name and eff_uuid:
                    export_rules = _fetch_export_policy_rules(client, eff_uuid, pol_name)

                mp = _build_mount_preflight(
                    svm_state=str(svm.get("state") or svm_state or "") or None,
                    junction_path=junction if isinstance(junction, str) else None,
                    nfs_lif=nfs_lif,
                    nfs_svc=nfs_svc,
                    nfs_protocols=nfs_protocols,
                    tcp=tcp,
                    export_policy_name=pol_name,
                    export_rules=export_rules,
                    client_cidrs=client_cidrs,
                )

                metadata: Dict[str, Any] = {
                    "size": vol.get("size") or space.get("size"),
                    "used": space.get("used"),
                    "available": space.get("available"),
                    "type": vol.get("type"),
                    "style": vol.get("style"),
                    "state": vol.get("state"),
                    "junction_path": junction,
                    "aggregates": aggrs or None,
                    "nfs_protocols": nfs_protocols,
                    "suggested_nfs_vers": _suggested_nfs_vers_mount(nfs_protocols),
                    "export_policy_name": pol_name,
                    "export_policy_rules": export_rules,
                    "mount_preflight": mp,
                }
                if nfs_lif:
                    metadata["nfs_data_lif"] = nfs_lif["address"]
                    if nfs_lif.get("lif_name"):
                        metadata["nfs_data_lif_name"] = nfs_lif["lif_name"]
                    metadata["nfs_data_lif_state"] = nfs_lif.get("lif_state")
                if nfs_svc:
                    metadata["nfs_service_enabled"] = nfs_svc.get("enabled")
                    metadata["nfs_service_state"] = nfs_svc.get("state")
                metadata["tcp_2049"] = tcp
                metadata["tcp_2049_ok"] = tcp.get("ok")
                metadata["tcp_2049_error"] = tcp.get("error")

                if page.truncated and idx == len(page.records) - 1:
                    metadata = _truncate_marker(metadata)
                nodes.append(
                    ExplorerNode(
                        id=f"ontap:vol/{uuid or name}",
                        label=name,
                        type="volume",
                        kind="Volume",
                        children_hint="hasChildren",
                        resource={
                            "svm_uuid": svm.get("uuid", svm_uuid),
                            "svm_name": svm.get("name", svm_name),
                            "volume_uuid": uuid,
                            "volume_name": name,
                        },
                        actions=["listSnapshots"],
                        metadata=metadata,
                    )
                )
        return ExplorerResponse(nodes=nodes)

    def _test_volume_mount(
        self, config: Dict[str, Any], credential: Dict[str, str], payload: Dict[str, Any]
    ) -> ExplorerResponse:
        """Re-run mount preflight for a single volume (by uuid or name)."""
        svm_uuid = (payload.get("svm_uuid") or "").strip()
        svm_name = (payload.get("svm_name") or "").strip()
        vol_uuid = (payload.get("volume_uuid") or "").strip()
        vol_name = (payload.get("volume_name") or "").strip()
        default_svm = _extract_default_svm(config)
        if not svm_uuid and not svm_name:
            if default_svm:
                svm_name = default_svm
            else:
                return ExplorerResponse(error=ExplorerError("VALIDATION_ERROR", "svm_uuid or svm_name required"))
        if not vol_uuid and not vol_name:
            return ExplorerResponse(error=ExplorerError("VALIDATION_ERROR", "volume_uuid or volume_name required"))

        fld = "uuid,name,state,size,space,type,style,svm,aggregates,nas"
        client_cidrs = _extract_client_cidrs(config)

        with _client_from_config(config, credential) as client:
            if vol_uuid:
                try:
                    vol = client.get(f"/api/storage/volumes/{vol_uuid}", params={"fields": fld})
                except OntapError:
                    return ExplorerResponse(error=ExplorerError("NOT_FOUND", f"volume {vol_uuid} not found"))
                records = [vol]
                page_truncated = False
            else:
                params: Dict[str, Any] = {"fields": fld, "name": vol_name}
                if svm_uuid:
                    params["svm.uuid"] = svm_uuid
                else:
                    params["svm.name"] = svm_name
                page = client.get_paginated("/api/storage/volumes", params=params, max_records=20)
                records = page.records
                page_truncated = page.truncated

            if not records:
                return ExplorerResponse(error=ExplorerError("NOT_FOUND", "volume not found in SVM"))

            vol = records[0]
            svm = vol.get("svm") or {}
            eff_uuid = (svm_uuid or svm.get("uuid") or "").strip()
            eff_name = (svm_name or svm.get("name") or "").strip()
            svm_state = svm.get("state")

            nfs_lif = _nfs_data_lif_for_svm(client, eff_uuid, eff_name)
            nfs_svc = _svm_nfs_service(client, eff_uuid, eff_name)
            nfs_protocols = _parse_nfs_protocols(nfs_svc)
            tcp = (
                _tcp_probe(nfs_lif["address"])
                if nfs_lif and nfs_lif.get("address")
                else {"ok": False, "error": "no lif", "probe_origin": "connector_worker_pod"}
            )

            space = vol.get("space") or {}
            nas = vol.get("nas") or {}
            aggrs = ",".join((a.get("name") or "") for a in (vol.get("aggregates") or []) if a.get("name"))
            junction = nas.get("path")
            pol_name = (nas.get("export_policy") or {}).get("name") if isinstance(nas.get("export_policy"), dict) else None
            export_rules: List[Dict[str, Any]] = []
            if pol_name and eff_uuid:
                export_rules = _fetch_export_policy_rules(client, eff_uuid, pol_name)

            mp = _build_mount_preflight(
                svm_state=str(svm_state or "") or None,
                junction_path=junction if isinstance(junction, str) else None,
                nfs_lif=nfs_lif,
                nfs_svc=nfs_svc,
                nfs_protocols=nfs_protocols,
                tcp=tcp,
                export_policy_name=pol_name,
                export_rules=export_rules,
                client_cidrs=client_cidrs,
            )

            uuid = vol.get("uuid", "")
            name = vol.get("name", uuid or "volume")
            metadata: Dict[str, Any] = {
                "size": vol.get("size") or space.get("size"),
                "used": space.get("used"),
                "available": space.get("available"),
                "type": vol.get("type"),
                "style": vol.get("style"),
                "state": vol.get("state"),
                "junction_path": junction,
                "aggregates": aggrs or None,
                "nfs_protocols": nfs_protocols,
                "suggested_nfs_vers": _suggested_nfs_vers_mount(nfs_protocols),
                "export_policy_name": pol_name,
                "export_policy_rules": export_rules,
                "mount_preflight": mp,
            }
            if nfs_lif:
                metadata["nfs_data_lif"] = nfs_lif["address"]
                if nfs_lif.get("lif_name"):
                    metadata["nfs_data_lif_name"] = nfs_lif["lif_name"]
                metadata["nfs_data_lif_state"] = nfs_lif.get("lif_state")
            if nfs_svc:
                metadata["nfs_service_enabled"] = nfs_svc.get("enabled")
                metadata["nfs_service_state"] = nfs_svc.get("state")
            metadata["tcp_2049"] = tcp
            metadata["tcp_2049_ok"] = tcp.get("ok")
            metadata["tcp_2049_error"] = tcp.get("error")
            if page_truncated:
                metadata = _truncate_marker(metadata)

            node = ExplorerNode(
                id=f"ontap:vol/{uuid or name}",
                label=name,
                type="volume",
                kind="Volume",
                children_hint="hasChildren",
                resource={
                    "svm_uuid": svm.get("uuid", svm_uuid),
                    "svm_name": svm.get("name", svm_name),
                    "volume_uuid": uuid,
                    "volume_name": name,
                },
                actions=["listSnapshots"],
                metadata=metadata,
            )
        return ExplorerResponse(nodes=[node])

    def _resolve_best_mount_for_volume(
        self, config: Dict[str, Any], credential: Dict[str, str], payload: Dict[str, Any]
    ) -> ExplorerResponse:
        r = self._test_volume_mount(config, credential, payload)
        if r.error or not r.nodes:
            return r
        n = r.nodes[0]
        meta = n.metadata or {}
        res = n.resource or {}
        junction = meta.get("junction_path") or ""
        lif = meta.get("nfs_data_lif") or ""
        vers = meta.get("suggested_nfs_vers") or "vers=3"
        endpoint = f"{lif}:{junction if str(junction).startswith('/') else '/' + str(junction)}" if lif else ""
        mount_opts = ["noac", "soft", "timeo=50", "retrans=3", vers]
        return ExplorerResponse(
            nodes=[
                ExplorerNode(
                    id=n.id,
                    label=n.label,
                    type="resolution",
                    kind="MountResolution",
                    children_hint="leaf",
                    resource={
                        **res,
                        "best_lif": lif,
                        "junction_path": junction,
                        "endpoint": endpoint,
                        "mount_options": mount_opts,
                    },
                    metadata={"mount_preflight": meta.get("mount_preflight"), "nfs_protocols": meta.get("nfs_protocols")},
                )
            ]
        )

    def _test_network_interface_reachability(
        self, config: Dict[str, Any], credential: Dict[str, str], payload: Dict[str, Any]
    ) -> ExplorerResponse:
        addr = (payload.get("address") or "").strip()
        if not addr:
            return ExplorerResponse(error=ExplorerError("VALIDATION_ERROR", "address required"))
        tcp = _tcp_probe(addr)
        return ExplorerResponse(
            nodes=[
                ExplorerNode(
                    id=f"ontap:probe/{addr}",
                    label=addr,
                    type="probe",
                    kind="TcpProbe",
                    children_hint="leaf",
                    metadata={"tcp_2049": tcp},
                )
            ]
        )

    def _list_svm_interfaces(
        self, config: Dict[str, Any], credential: Dict[str, str], payload: Dict[str, Any]
    ) -> ExplorerResponse:
        return self._list_network_interfaces(config, credential, payload, svm_scoped=True)

    # ── listLuns ───────────────────────────────────────────────────────────

    def _list_luns(
        self, config: Dict[str, Any], credential: Dict[str, str], payload: Dict[str, Any]
    ) -> ExplorerResponse:
        svm_uuid = (payload.get("svm_uuid") or "").strip()
        svm_name = (payload.get("svm_name") or "").strip()
        default_svm = _extract_default_svm(config)
        if not svm_uuid and not svm_name:
            if default_svm:
                svm_name = default_svm
            else:
                return ExplorerResponse(
                    error=ExplorerError("VALIDATION_ERROR", "svm_uuid or svm_name is required for listLuns"),
                )

        params: Dict[str, Any] = {
            "fields": "uuid,name,space,os_type,status,serial_number,svm",
        }
        if svm_uuid:
            params["svm.uuid"] = svm_uuid
        else:
            params["svm.name"] = svm_name

        with _client_from_config(config, credential) as client:
            page = client.get_paginated("/api/storage/luns", params=params)

        nodes: List[ExplorerNode] = []
        for idx, lun in enumerate(page.records):
            uuid = lun.get("uuid", "")
            name = lun.get("name", uuid or f"lun-{idx}")
            space = lun.get("space") or {}
            status = lun.get("status") or {}
            metadata: Dict[str, Any] = {
                "size": space.get("size"),
                "mapped": status.get("mapped"),
                "state": status.get("state"),
                "os_type": lun.get("os_type"),
                "serial_number": lun.get("serial_number"),
            }
            if page.truncated and idx == len(page.records) - 1:
                metadata = _truncate_marker(metadata)
            nodes.append(
                ExplorerNode(
                    id=f"ontap:lun/{uuid or name}",
                    label=name,
                    type="lun",
                    children_hint="leaf",
                    resource={
                        "svm_uuid": svm_uuid,
                        "svm_name": svm_name,
                        "lun_uuid": uuid,
                        "lun_name": name,
                    },
                    metadata=metadata,
                )
            )
        return ExplorerResponse(nodes=nodes)

    # ── listSnapshots ──────────────────────────────────────────────────────

    def _list_snapshots(
        self, config: Dict[str, Any], credential: Dict[str, str], payload: Dict[str, Any]
    ) -> ExplorerResponse:
        volume_uuid = (payload.get("volume_uuid") or "").strip()
        if not volume_uuid:
            return ExplorerResponse(
                error=ExplorerError("VALIDATION_ERROR", "volume_uuid is required for listSnapshots"),
            )

        with _client_from_config(config, credential) as client:
            page = client.get_paginated(
                f"/api/storage/volumes/{volume_uuid}/snapshots",
                params={"fields": "uuid,name,create_time,size,state"},
            )

        nodes: List[ExplorerNode] = []
        for idx, snap in enumerate(page.records):
            uuid = snap.get("uuid", "")
            name = snap.get("name", uuid or f"snapshot-{idx}")
            metadata: Dict[str, Any] = {
                "create_time": snap.get("create_time"),
                "size": snap.get("size"),
                "state": snap.get("state"),
            }
            if page.truncated and idx == len(page.records) - 1:
                metadata = _truncate_marker(metadata)
            nodes.append(
                ExplorerNode(
                    id=f"ontap:snap/{volume_uuid}/{uuid or name}",
                    label=name,
                    type="snapshot",
                    kind="Snapshot",
                    children_hint="leaf",
                    resource={
                        "volume_uuid": volume_uuid,
                        "snapshot_uuid": uuid,
                        "snapshot_name": name,
                    },
                    metadata=metadata,
                )
            )
        return ExplorerResponse(nodes=nodes)

    # ── listAggregates ─────────────────────────────────────────────────────

    def _list_aggregates(
        self, config: Dict[str, Any], credential: Dict[str, str]
    ) -> ExplorerResponse:
        with _client_from_config(config, credential) as client:
            page = client.get_paginated(
                "/api/storage/aggregates",
                params={"fields": "uuid,name,space,block_storage,node,state"},
            )

        nodes: List[ExplorerNode] = []
        for idx, agg in enumerate(page.records):
            uuid = agg.get("uuid", "")
            name = agg.get("name", uuid or f"aggregate-{idx}")
            block = agg.get("block_storage") or {}
            primary = (block.get("primary") or {})
            space = (agg.get("space") or {}).get("block_storage") or {}
            node_obj = agg.get("node") or {}
            metadata: Dict[str, Any] = {
                "space_total": space.get("size"),
                "space_used": space.get("used"),
                "space_available": space.get("available"),
                "raid_type": primary.get("raid_type"),
                "node": node_obj.get("name"),
                "state": agg.get("state"),
            }
            if page.truncated and idx == len(page.records) - 1:
                metadata = _truncate_marker(metadata)
            nodes.append(
                ExplorerNode(
                    id=f"ontap:agg/{uuid or name}",
                    label=name,
                    type="aggregate",
                    children_hint="leaf",
                    resource={"aggregate_uuid": uuid, "aggregate_name": name},
                    metadata=metadata,
                )
            )
        return ExplorerResponse(nodes=nodes)

    # ── listNetworkInterfaces ──────────────────────────────────────────────

    def _list_network_interfaces(
        self,
        config: Dict[str, Any],
        credential: Dict[str, str],
        payload: Dict[str, Any],
        svm_scoped: bool = False,
    ) -> ExplorerResponse:
        svm_uuid = (payload.get("svm_uuid") or "").strip()
        svm_name = (payload.get("svm_name") or "").strip()
        default_svm = _extract_default_svm(config)
        if svm_scoped and not svm_uuid and not svm_name:
            if default_svm:
                svm_name = default_svm
            else:
                return ExplorerResponse(
                    error=ExplorerError("VALIDATION_ERROR", "svm_uuid or svm_name is required for listSvmInterfaces"),
                )

        params: Dict[str, Any] = {
            "fields": "uuid,name,ip,scope,services,svm,state,location",
        }
        if svm_uuid:
            params["svm.uuid"] = svm_uuid
        elif svm_name:
            params["svm.name"] = svm_name

        with _client_from_config(config, credential) as client:
            page = client.get_paginated(
                "/api/network/ip/interfaces",
                params=params,
                max_records=200,
            )

        nodes: List[ExplorerNode] = []
        for idx, lif in enumerate(page.records):
            uuid = lif.get("uuid", "")
            name = lif.get("name", uuid or f"lif-{idx}")
            ip = (lif.get("ip") or {}).get("address")
            services = lif.get("services") or []
            svm = lif.get("svm") or {}
            loc = lif.get("location") or {}
            home_node = (loc.get("home_node") or {}).get("name") or loc.get("home_node")
            current_node = (loc.get("current_node") or {}).get("name") or loc.get("current_node")
            is_data = _lif_has_data_nfs(lif)
            tcp_2049: Dict[str, Any] = {"ok": True, "error": None, "probe_origin": "connector_worker_pod"}
            if is_data and ip:
                tcp_2049 = _tcp_probe(str(ip).strip())
            elif is_data and not ip:
                tcp_2049 = {"ok": False, "error": "no address", "probe_origin": "connector_worker_pod"}

            svc_list = services if isinstance(services, list) else []
            metadata: Dict[str, Any] = {
                "address": ip,
                "ip_address": ip,
                "scope": lif.get("scope"),
                "services": svc_list,
                "services_csv": ",".join(str(s) for s in svc_list),
                "svm": svm.get("name"),
                "svm_uuid": svm.get("uuid"),
                "state": lif.get("state"),
                "home_node": home_node,
                "current_node": current_node,
                "is_data_nfs": is_data,
                "tcp_2049": tcp_2049,
            }
            if page.truncated and idx == len(page.records) - 1:
                metadata = _truncate_marker(metadata)
            nodes.append(
                ExplorerNode(
                    id=f"ontap:lif/{uuid or name}",
                    label=name,
                    type="networkInterface",
                    children_hint="leaf",
                    resource={
                        "interface_uuid": uuid,
                        "interface_name": name,
                        "svm_uuid": svm.get("uuid"),
                        "svm_name": svm.get("name"),
                    },
                    metadata=metadata,
                )
            )
        return ExplorerResponse(nodes=nodes)
