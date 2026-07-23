"""Generate the OpenAPI / Swagger spec for the agent framework.

Imports ``create_app`` and dumps the auto-generated FastAPI OpenAPI document
to ``docs/openapi.json`` and ``docs/openapi.yaml`` (developer-facing docs),
and to ``tests/fixtures/openapi.expected.json`` (machine-readable baseline
consumed by the §G5 OpenAPI drift check in CI).

Run with::

    PYTHONPATH=src python scripts/generate_openapi.py

Or via Makefile::

    make regen-openapi

To preview interactively, start the server and visit ``/docs`` (Swagger UI)
or ``/redoc`` (ReDoc) — those pages serve the same spec live.

Determinism (§H1)
-----------------

The generator is invoked with no environment-derived inputs and the FastAPI
``app.openapi()`` method walks routes / schemas in a stable order, so two
back-to-back runs produce byte-identical output. JSON is written with
``sort_keys=False`` (preserve FastAPI's path-declaration order) but the
input ordering is itself deterministic. The G5 drift-check test asserts
this by regenerating the spec at test time and diffing against the
committed fixture.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml  # PyYAML — already a transitive dep of pydantic-settings

from agent_service_maf.interface_layer.api import create_app

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs"
JSON_PATH = OUT_DIR / "openapi.json"
YAML_PATH = OUT_DIR / "openapi.yaml"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "openapi.expected.json"


def build_spec() -> dict[str, Any]:
    """Return the live OpenAPI document with §G5/§H1 normalisation applied.

    Used by both the CLI generator and the §G5 drift-check test.
    """
    app = create_app()
    return _decorate_spec(app.openapi())


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)

    spec = build_spec()

    JSON_PATH.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
    YAML_PATH.write_text(yaml.safe_dump(spec, sort_keys=False), encoding="utf-8")
    # §H1 / §G5: also write the machine-readable fixture that CI diffs
    # against. ``make regen-openapi`` updates this on intentional change.
    FIXTURE_PATH.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {JSON_PATH}")
    print(f"Wrote {YAML_PATH}")
    print(f"Wrote {FIXTURE_PATH}")
    print(f"Routes: {len(spec.get('paths', {}))}")
    print(f"Schemas: {len(spec.get('components', {}).get('schemas', {}))}")
    return 0


def _decorate_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Apply tags + security scheme decorations to the raw FastAPI spec."""
    # Tag the routes for friendlier grouping in Swagger UI / ReDoc
    for path, ops in spec.get("paths", {}).items():
        if path == "/health":
            tag = "health"
        elif path.startswith("/agent-teams"):
            tag = "agent-teams"
        elif path.startswith("/agents"):
            tag = "agents (legacy — alias to default team)"
        else:
            tag = "misc"
        for verb, op in ops.items():
            if isinstance(op, dict) and verb in {"get", "post", "put", "delete", "patch"}:
                op["tags"] = [tag]

    # Add an X-API-Key security scheme since the framework uses one
    sec_schemes = spec.setdefault("components", {}).setdefault("securitySchemes", {})
    sec_schemes["ApiKeyAuth"] = {
        "type": "apiKey",
        "in": "header",
        "name": "X-API-Key",
        "description": (
            "API key for endpoints under /agents and /agent-teams when "
            "interface.auth.enabled=true. /health is always exempt."
        ),
    }
    # Apply the security scheme globally (callers can omit when auth disabled)
    spec.setdefault("security", [{"ApiKeyAuth": []}])
    return spec


if __name__ == "__main__":
    sys.exit(main())
