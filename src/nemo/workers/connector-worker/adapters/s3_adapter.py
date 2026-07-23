"""S3 provider adapter for explorer actions."""
from observability_client_runtime import get_logger
from typing import Any, Dict

from activities.s3_helpers import get_external_s3_client

from .base import ExplorerError, ExplorerNode, ExplorerResponse, ProviderAdapter

logger = get_logger()


class S3Adapter(ProviderAdapter):
    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        try:
            if action == "listBuckets":
                return self._list_buckets(connector_config, credential)
            if action == "listPath":
                return self._list_path(connector_config, credential, payload)
            return ExplorerResponse(
                error=ExplorerError("UNSUPPORTED_ACTION", f"Action '{action}' not supported by S3 adapter"),
            )
        except Exception as e:
            logger.exception("S3 adapter error: action=%s", action)
            return ExplorerResponse(
                error=ExplorerError("PROVIDER_ERROR", str(e)),
            )

    def _list_buckets(
        self,
        config: Dict[str, Any],
        creds: Dict[str, str],
    ) -> ExplorerResponse:
        """List all buckets. Root action when no default bucket is configured."""
        s3 = get_external_s3_client(creds, config)
        resp = s3.list_buckets()
        nodes = []
        for b in resp.get("Buckets", []):
            name = b.get("Name")
            if not name:
                continue
            nodes.append(
                ExplorerNode(
                    id=f"s3://{name}",
                    label=name,
                    type="folder",
                    children_hint="hasChildren",
                    resource={"bucket": name, "prefix": ""},
                    actions=["listPath"],
                )
            )
        return ExplorerResponse(nodes=nodes)

    def _list_path(
        self,
        config: Dict[str, Any],
        creds: Dict[str, str],
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        s3 = get_external_s3_client(creds, config)
        bucket = payload.get("bucket") or config.get("bucket")
        prefix = payload.get("prefix", config.get("prefix", ""))
        delimiter = payload.get("delimiter", "/")
        next_token = payload.get("nextToken")

        if not bucket:
            return ExplorerResponse(
                error=ExplorerError("VALIDATION_ERROR", "No bucket specified in payload or connector config"),
            )

        params: Dict[str, Any] = {
            "Bucket": bucket,
            "Prefix": prefix,
            "Delimiter": delimiter,
            "MaxKeys": int(payload.get("maxKeys", 1000)),
        }
        if next_token:
            params["ContinuationToken"] = next_token

        resp = s3.list_objects_v2(**params)
        nodes = []

        for cp in resp.get("CommonPrefixes", []):
            folder_prefix = cp["Prefix"]
            folder_name = folder_prefix.rstrip("/").rsplit("/", 1)[-1]
            nodes.append(ExplorerNode(
                id=f"s3://{bucket}/{folder_prefix}",
                label=folder_name,
                type="folder",
                children_hint="hasChildren",
                resource={"bucket": bucket, "prefix": folder_prefix},
                actions=["listPath"],
            ))

        for obj in resp.get("Contents", []):
            key = obj["Key"]
            if key == prefix:
                continue
            file_name = key.rsplit("/", 1)[-1]
            if not file_name:
                continue
            ext = file_name.rsplit(".", 1)[-1] if "." in file_name else ""
            nodes.append(ExplorerNode(
                id=f"s3://{bucket}/{key}",
                label=file_name,
                type="file",
                kind=ext if ext else None,
                children_hint="leaf",
                resource={"bucket": bucket, "prefix": key},
                metadata={
                    "size": obj.get("Size", 0),
                    "lastModified": obj["LastModified"].isoformat() if obj.get("LastModified") else None,
                },
            ))

        response_next_token = resp.get("NextContinuationToken")
        return ExplorerResponse(nodes=nodes, next_token=response_next_token)

    def resolve(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        resource_selector: Dict[str, Any],
    ) -> Dict[str, Any]:
        effective = dict(connector_config)
        if "bucket" in resource_selector:
            effective["bucket"] = resource_selector["bucket"]
        if "prefix" in resource_selector:
            effective["prefix"] = resource_selector["prefix"]
        return effective
