#!/usr/bin/env python3
"""Publish a pytest allure-results directory to the shared Allure service.

Targets the `allure-docker-service` HTTP API (frankescobar/allure-docker-service)
which hosts one Allure report per `project_id`, accumulating trend/history across
runs. One project is used per environment (dev-aks, dev-gke, stage, prod, pr-<n>,
vcluster-<id>, ...), so a single instance serves every cloud.

Driven entirely by environment variables so it is reusable from a GitHub Actions
runner or from an in-cluster Job (ephemeral / vCluster):

    ALLURE_ENDPOINT        base URL, e.g. https://allure.<infra-endpoint>   (required)
    ALLURE_PROJECT_ID      project id to publish under                      (required)
    ALLURE_RESULTS_DIR     allure-results dir (default: reports/allure-results)
    ALLURE_USERNAME        optional; login when the service has security enabled
    ALLURE_PASSWORD        optional; paired with ALLURE_USERNAME
    ALLURE_VERIFY_TLS      "0"/"false" to skip TLS verification (default: verify)
    ALLURE_EXECUTION_NAME  optional label shown on the report
    ALLURE_EXECUTION_FROM  optional URL linking back to the CI run

Best-effort by design: prints a clear error and exits non-zero on failure, but the
calling workflow step runs with continue-on-error so publishing never fails the
test gate (the pytest result is the gate).
"""

from __future__ import annotations

import base64
import http.cookiejar
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "allure-docker-service"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _flag(name: str, default: bool = True) -> bool:
    val = _env(name)
    if not val:
        return default
    return val.lower() not in ("0", "false", "no", "off")


class AllureClient:
    def __init__(self, base_url: str, verify_tls: bool) -> None:
        self.base = base_url.rstrip("/")
        self.csrf_token = ""
        self.cookies = http.cookiejar.CookieJar()
        ctx = None
        if not verify_tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies),
            *( [urllib.request.HTTPSHandler(context=ctx)] if ctx else [] ),
        )

    def _request(self, method: str, path: str, body: dict | None = None) -> tuple[int, bytes]:
        url = f"{self.base}/{API}/{path.lstrip('/')}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        # allure-docker-service uses JWT cookies + a CSRF header on writes.
        if self.csrf_token and method in ("POST", "PUT", "DELETE"):
            req.add_header("X-CSRF-TOKEN", self.csrf_token)
        try:
            resp = self.opener.open(req, timeout=60)
            return resp.getcode(), resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def login(self, username: str, password: str) -> None:
        code, payload = self._request(
            "POST", "login", {"username": username, "password": password}
        )
        if code not in (200, 201):
            raise RuntimeError(f"Allure login failed (HTTP {code}): {payload[:300]!r}")
        for cookie in self.cookies:
            if cookie.name == "csrf_access_token":
                self.csrf_token = cookie.value or ""
        if not self.csrf_token:
            print("WARN: logged in but no csrf_access_token cookie returned.")

    def ensure_project(self, project_id: str) -> None:
        code, payload = self._request("POST", "projects", {"id": project_id})
        if code in (200, 201):
            print(f"Created Allure project '{project_id}'.")
        elif code == 409:
            print(f"Allure project '{project_id}' already exists.")
        else:
            # Non-fatal: send-results with force_project_creation can still create it.
            print(f"WARN: ensure_project returned HTTP {code}: {payload[:200]!r}")

    def send_results(self, project_id: str, results_dir: Path) -> int:
        files = [p for p in sorted(results_dir.iterdir()) if p.is_file()]
        if not files:
            print(f"No result files in {results_dir}; nothing to publish.")
            return 0
        results = [
            {
                "file_name": p.name,
                "content_base64": base64.b64encode(p.read_bytes()).decode(),
            }
            for p in files
        ]
        code, payload = self._request(
            "POST",
            f"send-results?project_id={project_id}&force_project_creation=true",
            {"results": results},
        )
        if code not in (200, 201):
            raise RuntimeError(
                f"send-results failed (HTTP {code}): {payload[:300]!r}"
            )
        print(f"Sent {len(results)} result file(s) to project '{project_id}'.")
        return len(results)

    def generate_report(self, project_id: str, execution_name: str, execution_from: str) -> None:
        query = f"generate-report?project_id={project_id}"
        if execution_name:
            query += f"&execution_name={urllib.parse.quote(execution_name)}"
        if execution_from:
            query += f"&execution_from={urllib.parse.quote(execution_from)}"
        code, payload = self._request("GET", query)
        if code not in (200, 201):
            raise RuntimeError(
                f"generate-report failed (HTTP {code}): {payload[:300]!r}"
            )
        try:
            url = json.loads(payload).get("data", {}).get("report_url", "")
        except (json.JSONDecodeError, AttributeError):
            url = ""
        print(f"Report generated for '{project_id}'."
              + (f" {url}" if url else ""))


def main() -> int:
    base_url = _env("ALLURE_ENDPOINT")
    project_id = _env("ALLURE_PROJECT_ID")
    results_dir = Path(_env("ALLURE_RESULTS_DIR", "reports/allure-results"))

    if not base_url:
        print("ALLURE_ENDPOINT not set; skipping Allure publish.")
        return 0
    if not project_id:
        print("::error::ALLURE_PROJECT_ID is required to publish results.")
        return 1
    if not results_dir.is_dir():
        print(f"::error::Allure results dir not found: {results_dir}")
        return 1

    client = AllureClient(base_url, verify_tls=_flag("ALLURE_VERIFY_TLS"))

    username, password = _env("ALLURE_USERNAME"), _env("ALLURE_PASSWORD")
    if username and password:
        client.login(username, password)

    client.ensure_project(project_id)
    sent = client.send_results(project_id, results_dir)
    if sent:
        client.generate_report(
            project_id,
            execution_name=_env("ALLURE_EXECUTION_NAME"),
            execution_from=_env("ALLURE_EXECUTION_FROM"),
        )
    print(f"Allure publish complete: {base_url}/{API}/projects/{project_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
