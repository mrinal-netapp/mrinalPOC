"""Targeted branch-coverage tests to reach the 85% CI threshold."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

fakeredis = pytest.importorskip("fakeredis")
pytest.importorskip("temporalio")

from activities import acquisition_pipeline as ap  # noqa: E402
from activities.redash_client import (  # noqa: E402
    RedashAPIError,
    RedashClient,
    _resolve_ca_bundle,
)
from adapters.anf_metrics_adapter import _parse_volume_context, _safe_heartbeat  # noqa: E402
from adapters.ontap_adapter import (  # noqa: E402
    OntapAdapter,
    _extract_client_cidrs,
    _lif_has_data_nfs,
    _ontap_error_to_envelope,
    _suggested_nfs_vers_mount,
    _tcp_probe,
)
from ontap_common import (  # noqa: E402
    OntapAuthError,
    OntapHTTPError,
    OntapNetworkError,
    OntapTimeoutError,
    OntapTLSVerifyError,
)
from streaming.redis_stream import (  # noqa: E402
    JobStream,
    JobStreamConfig,
    _serialize_fields,
    _truthy,
)


def _call_activity(fn, *args, **kwargs):
    return getattr(fn, "__wrapped__", fn)(*args, **kwargs)


def _make_stream(wf="wf-boost", run="run-boost") -> JobStream:
    return JobStream(
        JobStreamConfig(
            workflow_id=wf,
            run_id=run,
            client=fakeredis.FakeRedis(decode_responses=True),
            ttl_seconds=3600,
            stream_maxlen=100,
        )
    )


class TestRedisStreamHelpers:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (None, False),
            ("", False),
            ("1", True),
            ("true", True),
            ("yes", True),
            ("on", True),
            ("0", False),
            (0, False),
            (1, True),
            (b"", False),
        ],
    )
    def test_truthy(self, value, expected):
        assert _truthy(value) is expected

    def test_serialize_fields_coerces_types(self):
        out = _serialize_fields(
            {
                "flag": True,
                "count": 42,
                "ratio": 1.5,
                "meta": {"a": 1},
                "none_val": None,
                "raw": object(),
            }
        )
        assert out["flag"] == "True"
        assert out["count"] == "42"
        assert out["ratio"] == "1.5"
        assert json.loads(out["meta"]) == {"a": 1}
        assert out["none_val"] == ""
        assert "object" in out["raw"]

    def test_mark_eof_raises_when_eof_seen_unreadable(self):
        class HgetDown(fakeredis.FakeRedis):
            def hget(self, name, key):  # type: ignore[no-untyped-def]
                raise ConnectionError("redis down")

        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-eof",
                run_id="run-1",
                client=HgetDown(),
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        with pytest.raises(RuntimeError, match="cannot read eofSeen"):
            js.mark_eof()

    def test_ack_returns_zero_on_redis_error(self):
        class AckDown(fakeredis.FakeRedis):
            def pipeline(self, transaction=True):  # type: ignore[no-untyped-def]
                raise ConnectionError("pipeline down")

        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-ack",
                run_id="run-1",
                client=AckDown(),
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        assert js.ack(["1-0"]) == 0


class TestOntapHelperBranches:
    @pytest.mark.parametrize(
        "exc,code",
        [
            (OntapTLSVerifyError(hint="fix certs"), "TLS_VERIFY_FAILED"),
            (OntapAuthError("bad", status=401), "UNAUTHORIZED"),
            (OntapTimeoutError("slow"), "TIMEOUT"),
            (OntapNetworkError("net"), "PROVIDER_ERROR"),
            (OntapHTTPError("http", status=500), "PROVIDER_ERROR"),
            (RuntimeError("boom"), "PROVIDER_ERROR"),
        ],
    )
    def test_error_envelope_mapping(self, exc, code):
        resp = _ontap_error_to_envelope(exc)
        assert resp.error is not None
        assert resp.error.code == code

    def test_extract_client_cidrs_list_and_string(self):
        assert _extract_client_cidrs({"client_cidrs": ["10.0.0.0/8", ""]}) == [
            "10.0.0.0/8"
        ]
        assert _extract_client_cidrs({"client_cidrs": "10.0.0.0/8, 172.16.0.0/12"}) == [
            "10.0.0.0/8",
            "172.16.0.0/12",
        ]
        assert _extract_client_cidrs({}) == []

    @pytest.mark.parametrize(
        "lif,expected",
        [
            ({"services": ["data_nfs"]}, True),
            ({"services": ["data-nfs"]}, True),
            ({"services": "data_nfs"}, False),
            ({"services": ["cifs"]}, False),
        ],
    )
    def test_lif_has_data_nfs(self, lif, expected):
        assert _lif_has_data_nfs(lif) is expected

    def test_tcp_probe_empty_host(self):
        assert _tcp_probe("")["ok"] is False

    @patch(
        "adapters.ontap_adapter.socket.create_connection",
        side_effect=OSError("refused"),
    )
    def test_tcp_probe_connection_refused(self, _mock_conn):
        assert _tcp_probe("10.0.0.99")["ok"] is False

    def test_suggested_nfs_vers_default_when_all_disabled(self):
        assert (
            _suggested_nfs_vers_mount({"v3": False, "v40": False, "v41": False})
            == "vers=3"
        )

    @patch(
        "adapters.ontap_adapter.OntapAdapter._list_services",
        side_effect=RuntimeError("boom"),
    )
    def test_execute_maps_generic_exception(self, _mock_list):
        resp = OntapAdapter().execute(
            {"cluster_url": "https://x"},
            {"username": "u", "password": "p"},
            "listServices",
            {},
        )
        assert resp.error.code == "PROVIDER_ERROR"


class TestRedashClientBranches:
    def test_resolve_ca_bundle_ssl_cert_file(self, monkeypatch):
        monkeypatch.setenv("REQUESTS_CA_BUNDLE", "")
        monkeypatch.setenv("SSL_CERT_FILE", "/etc/ssl/custom.pem")
        with patch("activities.redash_client.os.path.isfile", return_value=True):
            assert _resolve_ca_bundle() == "/etc/ssl/custom.pem"

    @patch("activities.redash_client.time.sleep")
    def test_request_retries_429_then_succeeds(self, _sleep):
        client = RedashClient("https://redash.example.com", "api-key")
        ok = MagicMock()
        ok.status_code = 200
        ok.content = b"{}"
        ok.json.return_value = {"results": []}
        ok.raise_for_status = MagicMock()
        err = MagicMock()
        err.status_code = 429
        err.content = b"rate limit"
        client._session.request = MagicMock(side_effect=[err, ok])
        assert client.test_connection() == {"ok": True}
        assert client._session.request.call_count == 2

    @patch("activities.redash_client.time.sleep")
    @patch("activities.redash_client.time.monotonic")
    def test_execute_sql_job_failure(self, mock_mono, _sleep):
        mock_mono.side_effect = [0.0, 0.0]
        client = RedashClient("https://redash.example.com", "api-key")
        ok = MagicMock(status_code=200, content=b"{}", raise_for_status=MagicMock())
        ok.json.side_effect = [
            {"job": {"id": "j1"}},
            {"job": {"status": 4, "error": "syntax"}},
        ]
        client._session.request = MagicMock(return_value=ok)
        with pytest.raises(RedashAPIError, match="failed"):
            client.execute_sql(2, "SELECT bad", poll_interval=0.01)

    @patch("activities.redash_client.time.sleep")
    def test_schema_refresh_failure_is_non_fatal(self, _sleep):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                RedashAPIError("refresh unavailable"),
                MagicMock(
                    status_code=200,
                    json=MagicMock(return_value={"schema": []}),
                    raise_for_status=MagicMock(),
                ),
            ],
        )
        assert client.get_data_source_schema(3, refresh=True) == []


class TestAnfHelperBranches:
    def test_parse_volume_context_filters_resource_group(self):
        ctx = _parse_volume_context(
            "",
            resource_group_filter="rg-a",
            volume_context={
                "resource_group": "rg-b",
                "volume_id": "v1",
                "volume_name": "vol1",
            },
        )
        assert ctx is None

    def test_parse_volume_context_returns_matching_context(self):
        ctx = _parse_volume_context(
            "",
            resource_group_filter="rg-a",
            volume_context={
                "resource_group": "rg-a",
                "volume_id": "v1",
                "volume_name": "vol1",
            },
        )
        assert ctx["volume_name"] == "vol1"

    def test_safe_heartbeat_swallows_callback_errors(self):
        def _bad(*_a, **_kw):
            raise RuntimeError("heartbeat failed")

        _safe_heartbeat(_bad, "detail")


class TestAcquisitionPipelineBranches:
    def test_discover_redis_ping_failure(self, monkeypatch):
        js = _make_stream("wf-ping", "run-ping")
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-ping", "run-ping")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})
        monkeypatch.setattr(js, "ping", lambda: False)

        with pytest.raises(RuntimeError, match="Redis unreachable"):
            _call_activity(
                ap.discover_object_store_items,
                {
                    "projectID": "p",
                    "credentialID": "c",
                    "configServiceURL": "http://cfg",
                    "connectorConfig": {"bucket": "b", "prefix": ""},
                },
            )

    def test_acquire_requires_output_bucket_for_server_side_copy(
        self, monkeypatch, tmp_path
    ):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        js = _make_stream("wf-acq", "run-acq")
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-acq", "run-acq")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "_jittered_ms", lambda base: min(base, 50))
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})
        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())
        monkeypatch.setattr(ap, "get_internal_s3_client", MagicMock())

        with pytest.raises(ValueError, match="outputBucket"):
            _call_activity(
                ap.acquire_batch,
                {
                    "projectID": "p",
                    "datasetID": "d",
                    "credentialID": "c",
                    "configServiceURL": "http://cfg",
                    "setId": "s0",
                    "connectorConfig": {
                        "bucket": "src",
                        "prefix": "",
                        "endpoint": "http://minio:9000",
                    },
                    "outputPath": "/projects/p/datasets/d/data_files",
                },
            )

    def test_cleanup_destroy_failure_returns_error(self, monkeypatch):
        broken = MagicMock()
        broken.destroy = MagicMock(side_effect=RuntimeError("destroy failed"))
        broken.stream_key = "acq:wf:run:items"
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: broken)

        out = _call_activity(
            ap.cleanup_acquisition_stream,
            {
                "workflowId": "wf",
                "runId": "run",
            },
        )
        assert out["destroyed"] is False
        assert "destroy failed" in out["error"]

    def test_put_facet_raises_on_http_error(self, monkeypatch):
        class _Resp:
            status = 500

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        monkeypatch.setattr(ap.urllib.request, "urlopen", lambda *a, **k: _Resp())
        with pytest.raises(RuntimeError, match="facet PUT"):
            ap._put_facet(
                "http://cfg", "p", "d", state="ready", job_id=None, summary={}
            )

    def test_delete_progress_raises_on_server_error(self, monkeypatch):
        class _Resp:
            status = 500

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        monkeypatch.setattr(ap.urllib.request, "urlopen", lambda *a, **k: _Resp())
        with pytest.raises(RuntimeError, match="DELETE progress"):
            ap._delete_progress("http://wf-engine", "wf-1")
