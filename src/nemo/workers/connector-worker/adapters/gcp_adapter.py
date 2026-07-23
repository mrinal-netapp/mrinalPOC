"""Google Cloud provider adapter for explorer actions.

Supports browsing Cloud SQL, Cloud Spanner, AlloyDB, GCNV (NetApp Volumes),
and Cloud Storage across GCP regions from a single account-scope connector.
"""
import json
from observability_client_runtime import get_logger
from typing import Any, Dict, List, Optional

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.cloud import storage

from .base import ExplorerError, ExplorerNode, ExplorerResponse, ProviderAdapter
from .metric_explorer_nodes import gcnv_metric_category_nodes
from activities.gcp_sa_json import resolve_gcp_service_account_json

logger = get_logger()

_GCP_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _build_credentials(credential: Dict[str, str]) -> service_account.Credentials:
    sa_json = resolve_gcp_service_account_json(credential)
    if not sa_json:
        raise json.JSONDecodeError("empty", "", 0)
    info = json.loads(sa_json)
    return service_account.Credentials.from_service_account_info(info, scopes=_GCP_SCOPES)


def _region_from_zone(zone: str) -> str:
    """Extract region from a GCP zone string (e.g. 'us-central1-a' -> 'us-central1')."""
    parts = zone.rsplit("-", 1)
    return parts[0] if len(parts) == 2 and len(parts[1]) == 1 else zone


def _is_gcp_zone(location: str) -> bool:
    """True when location is a GCP zone (e.g. us-central1-a), not a region."""
    if not location or "-" not in location:
        return False
    suffix = location.rsplit("-", 1)[-1]
    return len(suffix) == 1 and suffix.isalpha()


def _zones_in_region(
    creds: service_account.Credentials, project_id: str, region: str
) -> List[str]:
    """List Compute zone names (e.g. us-central1-a) within a region."""
    if not region:
        return []
    try:
        svc = build("compute", "v1", credentials=creds, cache_discovery=False)
        resp = svc.zones().list(project=project_id).execute()
        return sorted(
            z["name"]
            for z in resp.get("items", [])
            if _region_from_zone(z.get("name", "")) == region
        )
    except HttpError as e:
        logger.warning(
            "Could not list Compute zones for region %s; zonal GCNV resources may be missing: %s",
            region,
            e,
        )
        return []


def _gcnv_locations_for_scope(
    netapp_svc: Any, creds: service_account.Credentials, project_id: str, location: str
) -> List[str]:
    """NetApp Volumes API location IDs to query for a region or zone selection.

    GCNV zonal storage pools live under zone locations (us-central1-a) while
    regional pools use the region id (us-central1). Browsing by region must
    query both.
    """
    if not location:
        return ["-"]
    if _is_gcp_zone(location):
        return [location]

    locations = [location]
    try:
        resp = netapp_svc.projects().locations().list(name=f"projects/{project_id}").execute()
        for loc in resp.get("locations", []):
            loc_id = loc.get("locationId", "")
            if not loc_id:
                name = loc.get("name", "")
                loc_id = name.rsplit("/", 1)[-1] if name else ""
            if loc_id and loc_id != location and _region_from_zone(loc_id) == location:
                locations.append(loc_id)
    except HttpError as e:
        logger.warning(
            "NetApp locations.list failed for %s; falling back to Compute zones: %s",
            project_id,
            e,
        )
        for zone in _zones_in_region(creds, project_id, location):
            if zone not in locations:
                locations.append(zone)
    return locations


def _gcnv_monitoring_location_filter(location: str) -> str:
    """Cloud Monitoring filter clause matching a GCNV region and its zones."""
    if not location:
        return ""
    if _is_gcp_zone(location):
        return f' AND resource.labels.location = "{location}"'
    return (
        f' AND (resource.labels.location = "{location}"'
        f' OR resource.labels.location = monitoring.regex.full_match("{location}-[a-z]"))'
    )


def _api_not_enabled_response(service_label: str, err: HttpError) -> ExplorerResponse:
    detail = str(err)
    if "has not been used" in detail or "is not enabled" in detail or "accessNotConfigured" in detail:
        return ExplorerResponse(
            error=ExplorerError(
                "API_NOT_ENABLED",
                f"{service_label} API is not enabled for this project. "
                "Enable it at console.cloud.google.com/apis",
            )
        )
    return ExplorerResponse(error=ExplorerError("PROVIDER_ERROR", detail))


class GCPAdapter(ProviderAdapter):
    """Account-scope adapter for Google Cloud projects."""

    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        try:
            creds = _build_credentials(credential)
            project_id = connector_config.get("project_id", "")

            if action == "listRegions":
                return self._list_regions(creds, project_id)
            elif action == "listServices":
                return self._list_services(payload)
            elif action == "listResources":
                return self._list_resources(creds, project_id, payload)
            elif action == "listDatabases":
                return self._list_databases(creds, project_id, payload)
            elif action == "listInstances":
                return self._list_alloydb_instances(creds, project_id, payload)
            elif action == "listVolumes":
                return self._list_volumes(creds, project_id, payload)
            elif action == "listPath":
                return self._list_path(creds, project_id, payload)
            elif action == "listMetricCategories":
                return ExplorerResponse(nodes=gcnv_metric_category_nodes())
            else:
                return ExplorerResponse(
                    error=ExplorerError("UNSUPPORTED_ACTION", f"Action '{action}' not supported by GCP adapter")
                )
        except json.JSONDecodeError as e:
            logger.exception("GCP adapter: invalid service account JSON")
            return ExplorerResponse(error=ExplorerError("CREDENTIAL_ERROR", f"Invalid service account JSON: {e}"))
        except Exception as e:
            logger.exception("GCP adapter error: action=%s", action)
            return ExplorerResponse(error=ExplorerError("PROVIDER_ERROR", str(e)))

    # ── Regions ───────────────────────────────────────────────────────────

    def _list_regions(self, creds: service_account.Credentials, project_id: str) -> ExplorerResponse:
        svc = build("compute", "v1", credentials=creds, cache_discovery=False)
        resp = svc.regions().list(project=project_id).execute()
        nodes: List[ExplorerNode] = []
        for r in resp.get("items", []):
            name = r["name"]
            nodes.append(
                ExplorerNode(
                    id=f"gcp:region/{name}",
                    label=name,
                    type="region",
                    children_hint="hasChildren",
                    resource={"region": name},
                    actions=["listServices"],
                )
            )
        nodes.sort(key=lambda n: n.label)
        return ExplorerResponse(nodes=nodes)

    # ── Services (static) ────────────────────────────────────────────────

    def _list_services(self, payload: Dict[str, Any]) -> ExplorerResponse:
        region = payload.get("region", "")
        nodes = [
            ExplorerNode(
                id="gcp:svc/database",
                label="Database Services",
                type="service",
                children_hint="hasChildren",
                resource={"service": "database", "region": region},
                actions=["listResources"],
            ),
            ExplorerNode(
                id="gcp:svc/gcnv",
                label="NetApp Volumes",
                type="service",
                children_hint="hasChildren",
                resource={"service": "gcnv", "region": region},
                actions=["listResources"],
            ),
            ExplorerNode(
                id="gcp:svc/gcs",
                label="Cloud Storage",
                type="service",
                children_hint="hasChildren",
                resource={"service": "gcs", "region": region},
                actions=["listResources"],
            ),
            # Performance Metrics is intentionally project-scoped — Cloud
            # Monitoring time-series are aggregated at the project level — so
            # we do NOT attach the selected region to the resource. The node
            # is rendered alongside the other services under whichever region
            # the user has picked, but acquisition will pull metrics for the
            # whole project.
            ExplorerNode(
                id="gcp:svc/metrics",
                label="Performance Metrics",
                type="service",
                kind="metrics",
                children_hint="hasChildren",
                resource={"service": "metrics"},
                actions=["listMetricCategories"],
            ),
        ]
        return ExplorerResponse(nodes=nodes)

    # ── Resources (dispatch by service) ──────────────────────────────────

    def _list_resources(
        self, creds: service_account.Credentials, project_id: str, payload: Dict[str, Any]
    ) -> ExplorerResponse:
        service = payload.get("service", "")
        region = payload.get("region", "")

        if service == "database":
            return self._list_db_sub_services(region)
        elif service == "cloudsql":
            return self._list_cloudsql_instances(creds, project_id, region)
        elif service == "spanner":
            return self._list_spanner_instances(creds, project_id, region)
        elif service == "alloydb":
            return self._list_alloydb_clusters(creds, project_id, region)
        elif service == "gcnv":
            return self._list_storage_pools(creds, project_id, region)
        elif service == "gcs":
            return self._list_buckets(creds, project_id)
        else:
            return ExplorerResponse(
                error=ExplorerError("UNSUPPORTED_SERVICE", f"Unknown service '{service}'")
            )

    def _list_db_sub_services(self, region: str) -> ExplorerResponse:
        nodes = [
            ExplorerNode(
                id="gcp:svc/cloudsql",
                label="Cloud SQL",
                type="service",
                kind="cloudsql",
                children_hint="hasChildren",
                resource={"service": "cloudsql", "region": region},
                actions=["listResources"],
            ),
            ExplorerNode(
                id="gcp:svc/spanner",
                label="Cloud Spanner",
                type="service",
                kind="spanner",
                children_hint="hasChildren",
                resource={"service": "spanner", "region": region},
                actions=["listResources"],
            ),
            ExplorerNode(
                id="gcp:svc/alloydb",
                label="AlloyDB",
                type="service",
                kind="alloydb",
                children_hint="hasChildren",
                resource={"service": "alloydb", "region": region},
                actions=["listResources"],
            ),
        ]
        return ExplorerResponse(nodes=nodes)

    # ── Cloud SQL ────────────────────────────────────────────────────────

    def _list_cloudsql_instances(
        self, creds: service_account.Credentials, project_id: str, region: str
    ) -> ExplorerResponse:
        try:
            svc = build("sqladmin", "v1beta4", credentials=creds, cache_discovery=False)
            resp = svc.instances().list(project=project_id).execute()
        except HttpError as e:
            return _api_not_enabled_response("Cloud SQL Admin", e)

        nodes: List[ExplorerNode] = []
        for inst in resp.get("items", []):
            inst_region = _region_from_zone(inst.get("gceZone", ""))
            if region and inst_region != region:
                continue
            name = inst.get("name", "")
            db_version = inst.get("databaseVersion", "")
            kind = "postgresql" if "POSTGRES" in db_version.upper() else "mysql"
            nodes.append(
                ExplorerNode(
                    id=f"gcp:cloudsql/{name}",
                    label=name,
                    type="instance",
                    kind=kind,
                    children_hint="hasChildren",
                    resource={"service": "cloudsql", "instance": name, "region": inst_region},
                    actions=["listDatabases"],
                    metadata={
                        "databaseVersion": db_version,
                        "state": inst.get("state", ""),
                        "region": inst_region,
                        "tier": inst.get("settings", {}).get("tier", ""),
                    },
                )
            )
        return ExplorerResponse(nodes=nodes)

    def _list_cloudsql_databases(
        self, creds: service_account.Credentials, project_id: str, instance: str
    ) -> ExplorerResponse:
        try:
            svc = build("sqladmin", "v1beta4", credentials=creds, cache_discovery=False)
            resp = svc.databases().list(project=project_id, instance=instance).execute()
        except HttpError as e:
            return _api_not_enabled_response("Cloud SQL Admin", e)

        nodes: List[ExplorerNode] = []
        for db in resp.get("items", []):
            name = db.get("name", "")
            nodes.append(
                ExplorerNode(
                    id=f"gcp:cloudsql/{instance}/{name}",
                    label=name,
                    type="database",
                    children_hint="leaf",
                    resource={"service": "cloudsql", "instance": instance, "database": name},
                    metadata={"charset": db.get("charset", ""), "collation": db.get("collation", "")},
                )
            )
        return ExplorerResponse(nodes=nodes)

    # ── Cloud Spanner ────────────────────────────────────────────────────

    def _list_spanner_instances(
        self, creds: service_account.Credentials, project_id: str, region: str
    ) -> ExplorerResponse:
        try:
            svc = build("spanner", "v1", credentials=creds, cache_discovery=False)
            parent = f"projects/{project_id}"
            resp = svc.projects().instances().list(parent=parent).execute()
        except HttpError as e:
            return _api_not_enabled_response("Cloud Spanner", e)

        nodes: List[ExplorerNode] = []
        for inst in resp.get("instances", []):
            config = inst.get("config", "")
            config_short = config.rsplit("/", 1)[-1] if "/" in config else config
            is_regional = config_short.startswith("regional-")
            inst_region = config_short.replace("regional-", "") if is_regional else ""
            if region and is_regional and inst_region != region:
                continue
            display_name = inst.get("displayName", "")
            inst_name = inst.get("name", "").rsplit("/", 1)[-1]
            nodes.append(
                ExplorerNode(
                    id=f"gcp:spanner/{inst_name}",
                    label=display_name or inst_name,
                    type="instance",
                    kind="spanner",
                    children_hint="hasChildren",
                    resource={"service": "spanner", "instance": inst_name},
                    actions=["listDatabases"],
                    metadata={
                        "config": config_short,
                        "state": inst.get("state", ""),
                        "nodeCount": inst.get("nodeCount", 0),
                    },
                )
            )
        return ExplorerResponse(nodes=nodes)

    def _list_spanner_databases(
        self, creds: service_account.Credentials, project_id: str, instance: str
    ) -> ExplorerResponse:
        try:
            svc = build("spanner", "v1", credentials=creds, cache_discovery=False)
            parent = f"projects/{project_id}/instances/{instance}"
            resp = svc.projects().instances().databases().list(parent=parent).execute()
        except HttpError as e:
            return _api_not_enabled_response("Cloud Spanner", e)

        nodes: List[ExplorerNode] = []
        for db in resp.get("databases", []):
            db_name = db.get("name", "").rsplit("/", 1)[-1]
            nodes.append(
                ExplorerNode(
                    id=f"gcp:spanner/{instance}/{db_name}",
                    label=db_name,
                    type="database",
                    children_hint="leaf",
                    resource={"service": "spanner", "instance": instance, "database": db_name},
                    metadata={"state": db.get("state", "")},
                )
            )
        return ExplorerResponse(nodes=nodes)

    # ── AlloyDB ──────────────────────────────────────────────────────────

    def _list_alloydb_clusters(
        self, creds: service_account.Credentials, project_id: str, region: str
    ) -> ExplorerResponse:
        try:
            svc = build("alloydb", "v1", credentials=creds, cache_discovery=False)
            # Use '-' wildcard to list across all locations, then filter
            parent = f"projects/{project_id}/locations/{region or '-'}"
            resp = svc.projects().locations().clusters().list(parent=parent).execute()
        except HttpError as e:
            return _api_not_enabled_response("AlloyDB", e)

        nodes: List[ExplorerNode] = []
        for cluster in resp.get("clusters", []):
            name = cluster.get("name", "")
            short_name = name.rsplit("/", 1)[-1]
            cluster_region = name.split("/locations/")[-1].split("/")[0] if "/locations/" in name else ""
            nodes.append(
                ExplorerNode(
                    id=f"gcp:alloydb/{short_name}",
                    label=short_name,
                    type="cluster",
                    kind="alloydb",
                    children_hint="hasChildren",
                    resource={"service": "alloydb", "cluster": name, "region": cluster_region},
                    actions=["listInstances"],
                    metadata={
                        "state": cluster.get("state", ""),
                        "databaseVersion": cluster.get("databaseVersion", ""),
                        "region": cluster_region,
                    },
                )
            )
        return ExplorerResponse(nodes=nodes)

    def _list_alloydb_instances(
        self, creds: service_account.Credentials, project_id: str, payload: Dict[str, Any]
    ) -> ExplorerResponse:
        cluster_name = payload.get("cluster", "")
        if not cluster_name:
            return ExplorerResponse(error=ExplorerError("VALIDATION_ERROR", "cluster is required"))

        try:
            svc = build("alloydb", "v1", credentials=creds, cache_discovery=False)
            resp = svc.projects().locations().clusters().instances().list(parent=cluster_name).execute()
        except HttpError as e:
            return _api_not_enabled_response("AlloyDB", e)

        nodes: List[ExplorerNode] = []
        for inst in resp.get("instances", []):
            name = inst.get("name", "")
            short_name = name.rsplit("/", 1)[-1]
            ip_address = inst.get("ipAddress", "")
            nodes.append(
                ExplorerNode(
                    id=f"gcp:alloydb/{name}",
                    label=short_name,
                    type="instance",
                    kind="alloydb",
                    children_hint="leaf",
                    resource={"service": "alloydb", "instance": name},
                    metadata={
                        "instanceType": inst.get("instanceType", ""),
                        "state": inst.get("state", ""),
                        "ipAddress": ip_address,
                        "databaseVersion": inst.get("databaseVersion", ""),
                    },
                )
            )
        return ExplorerResponse(nodes=nodes)

    # ── Databases (dispatch) ─────────────────────────────────────────────

    def _list_databases(
        self, creds: service_account.Credentials, project_id: str, payload: Dict[str, Any]
    ) -> ExplorerResponse:
        service = payload.get("service", "")
        instance = payload.get("instance", "")
        if not instance:
            return ExplorerResponse(error=ExplorerError("VALIDATION_ERROR", "instance is required"))

        if service == "cloudsql":
            return self._list_cloudsql_databases(creds, project_id, instance)
        elif service == "spanner":
            return self._list_spanner_databases(creds, project_id, instance)
        else:
            return ExplorerResponse(
                error=ExplorerError("UNSUPPORTED_SERVICE", f"listDatabases not supported for '{service}'")
            )

    # ── GCNV (NetApp Volumes) ────────────────────────────────────────────

    def _list_storage_pools(
        self, creds: service_account.Credentials, project_id: str, region: str
    ) -> ExplorerResponse:
        try:
            svc = build("netapp", "v1", credentials=creds, cache_discovery=False)
            locations = _gcnv_locations_for_scope(svc, creds, project_id, region)
            pools: List[Dict[str, Any]] = []
            for loc in locations:
                parent = f"projects/{project_id}/locations/{loc}"
                resp = svc.projects().locations().storagePools().list(parent=parent).execute()
                pools.extend(resp.get("storagePools", []))
        except HttpError as e:
            return _api_not_enabled_response("NetApp Volumes", e)

        nodes: List[ExplorerNode] = []
        for pool in pools:
            name = pool.get("name", "")
            short_name = name.rsplit("/", 1)[-1]
            pool_region = name.split("/locations/")[-1].split("/")[0] if "/locations/" in name else ""
            cap_bytes = int(pool.get("capacityGib", 0)) * (1024 ** 3) if pool.get("capacityGib") else None
            nodes.append(
                ExplorerNode(
                    id=f"gcp:gcnv/pool/{short_name}",
                    label=short_name,
                    type="storagePool",
                    children_hint="hasChildren",
                    resource={"service": "gcnv", "storagePool": name, "region": pool_region},
                    actions=["listVolumes"],
                    metadata={
                        "serviceLevel": pool.get("serviceLevel", ""),
                        "capacityGib": pool.get("capacityGib"),
                        "state": pool.get("state", ""),
                        "region": pool_region,
                    },
                )
            )
        return ExplorerResponse(nodes=nodes)

    def _list_volumes(
        self, creds: service_account.Credentials, project_id: str, payload: Dict[str, Any]
    ) -> ExplorerResponse:
        storage_pool = payload.get("storagePool", "")
        region = payload.get("region", "")

        try:
            svc = build("netapp", "v1", credentials=creds, cache_discovery=False)
            locations = _gcnv_locations_for_scope(svc, creds, project_id, region)
            volumes: List[Dict[str, Any]] = []
            for loc in locations:
                parent = f"projects/{project_id}/locations/{loc}"
                resp = svc.projects().locations().volumes().list(parent=parent).execute()
                volumes.extend(resp.get("volumes", []))
        except HttpError as e:
            return _api_not_enabled_response("NetApp Volumes", e)

        # Match volumes to the selected pool by SHORT name (last path
        # segment), not full resource path. The GCNV API normalizes
        # Volume.storagePool to the project-NUMBER form
        # (projects/{projectNumber}/locations/{loc}/storagePools/{pool}),
        # whereas the pool node carried the storagePools().list `name`, which
        # reflects the project-ID we passed in the parent. Comparing the full
        # strings therefore never matches (project-id vs project-number) and
        # silently drops every volume. Pool IDs are unique within a location,
        # so the last segment is a safe, format-agnostic key.
        want_pool = storage_pool.rsplit("/", 1)[-1] if storage_pool else ""
        nodes: List[ExplorerNode] = []
        for vol in volumes:
            vol_pool = vol.get("storagePool", "").rsplit("/", 1)[-1]
            if want_pool and vol_pool != want_pool:
                continue
            name = vol.get("name", "")
            short_name = name.rsplit("/", 1)[-1]
            cap_gib = vol.get("capacityGib")
            nodes.append(
                ExplorerNode(
                    id=f"gcp:gcnv/vol/{short_name}",
                    label=short_name,
                    type="volume",
                    children_hint="leaf",
                    resource={"service": "gcnv", "volume": name},
                    metadata={
                        "capacityGib": cap_gib,
                        "state": vol.get("state", ""),
                        "shareName": vol.get("shareName", ""),
                        "protocol": ",".join(vol.get("protocols", [])),
                    },
                )
            )
        return ExplorerResponse(nodes=nodes)

    # ── Cloud Storage (GCS) ──────────────────────────────────────────────

    def _list_buckets(
        self, creds: service_account.Credentials, project_id: str
    ) -> ExplorerResponse:
        try:
            client = storage.Client(project=project_id, credentials=creds)
            buckets = list(client.list_buckets())
        except Exception as e:
            err_str = str(e)
            if "has not been used" in err_str or "is not enabled" in err_str:
                return ExplorerResponse(
                    error=ExplorerError(
                        "API_NOT_ENABLED",
                        "Cloud Storage API is not enabled for this project.",
                    )
                )
            raise

        nodes: List[ExplorerNode] = []
        for b in buckets:
            nodes.append(
                ExplorerNode(
                    id=f"gs://{b.name}",
                    label=b.name,
                    type="resource",
                    kind="bucket",
                    children_hint="hasChildren",
                    resource={"bucket": b.name, "prefix": ""},
                    actions=["listPath"],
                    metadata={
                        "location": b.location,
                        "storageClass": b.storage_class,
                    },
                )
            )
        return ExplorerResponse(nodes=nodes)

    def _list_path(
        self, creds: service_account.Credentials, project_id: str, payload: Dict[str, Any]
    ) -> ExplorerResponse:
        bucket_name = payload.get("bucket")
        if not bucket_name:
            return ExplorerResponse(
                error=ExplorerError("VALIDATION_ERROR", "bucket is required in payload for listPath")
            )

        prefix = payload.get("prefix", "")
        delimiter = payload.get("delimiter", "/")
        max_results = int(payload.get("maxKeys", 1000))
        page_token = payload.get("nextToken")

        try:
            client = storage.Client(project=project_id, credentials=creds)
            bucket = client.bucket(bucket_name)
            iterator = bucket.list_blobs(
                prefix=prefix,
                delimiter=delimiter,
                max_results=max_results,
                page_token=page_token,
            )
            blobs = list(iterator)
        except Exception as e:
            return ExplorerResponse(error=ExplorerError("PROVIDER_ERROR", str(e)))

        nodes: List[ExplorerNode] = []

        for folder_prefix in sorted(iterator.prefixes):
            folder_name = folder_prefix.rstrip("/").rsplit("/", 1)[-1]
            nodes.append(
                ExplorerNode(
                    id=f"gs://{bucket_name}/{folder_prefix}",
                    label=folder_name,
                    type="folder",
                    children_hint="hasChildren",
                    resource={"bucket": bucket_name, "prefix": folder_prefix},
                    actions=["listPath"],
                )
            )

        for blob in blobs:
            if blob.name == prefix:
                continue
            file_name = blob.name.rsplit("/", 1)[-1]
            if not file_name:
                continue
            ext = file_name.rsplit(".", 1)[-1] if "." in file_name else ""
            nodes.append(
                ExplorerNode(
                    id=f"gs://{bucket_name}/{blob.name}",
                    label=file_name,
                    type="file",
                    kind=ext if ext else None,
                    children_hint="leaf",
                    resource={"bucket": bucket_name, "prefix": blob.name},
                    metadata={
                        "size": blob.size,
                        "lastModified": blob.updated.isoformat() if blob.updated else None,
                    },
                )
            )

        next_token = iterator.next_page_token
        return ExplorerResponse(nodes=nodes, next_token=next_token)

    # ── Resolve ──────────────────────────────────────────────────────────

    def resolve(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        resource_selector: Dict[str, Any],
    ) -> Dict[str, Any]:
        effective = dict(connector_config)
        effective.update(resource_selector)
        return effective
