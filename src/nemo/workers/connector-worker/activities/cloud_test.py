"""Cloud connector test activity: validates GCP credentials and basic API access."""
import json
from observability_client_runtime import get_logger
from typing import Any, Dict

from google.oauth2 import service_account
from googleapiclient.discovery import build
from temporalio import activity

from .credentials import resolve_credential
from .gcp_sa_json import resolve_gcp_service_account_json
from .activity_logging import log_activity_start, log_activity_result

logger = get_logger()

_GCP_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


@activity.defn(name="TestCloudConnection")
def test_cloud_connection(input: dict) -> dict:
    log_activity_start(input)
    config: Dict[str, Any] = input["connectorConfig"]
    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )

    try:
        sa_json = resolve_gcp_service_account_json(creds)
        if not sa_json:
            result = {
                "success": False,
                "message": (
                    "GCP credential is missing service account JSON. "
                    "Recreate or rotate the credential with a valid key file."
                ),
            }
            log_activity_result(result)
            return result
        info = json.loads(sa_json)
        credentials = service_account.Credentials.from_service_account_info(info, scopes=_GCP_SCOPES)
        project_id = config.get("project_id", info.get("project_id", ""))

        svc = build("compute", "v1", credentials=credentials, cache_discovery=False)
        resp = svc.regions().list(project=project_id, maxResults=1).execute()

        region_count = resp.get("items", [])
        result = {
            "success": True,
            "message": f"Connection successful; project '{project_id}' accessible ({len(region_count)} region(s) verified).",
        }
        log_activity_result(result)
        return result
    except json.JSONDecodeError as e:
        result = {"success": False, "message": f"Invalid service account JSON: {e}"}
        log_activity_result(result)
        return result
    except Exception as e:
        result = {"success": False, "message": f"Connection failed: {e}"}
        log_activity_result(result)
        return result
