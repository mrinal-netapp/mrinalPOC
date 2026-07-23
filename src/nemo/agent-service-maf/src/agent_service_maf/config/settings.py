"""Process-wide settings for the MAF → config-service migration.

A thin env-backed wrapper that mirrors the agent-service style without
pulling in pydantic-settings (kept lightweight on purpose so the import is
cheap and the test escape hatch — flipping ``CONFIG_SOURCE`` — works without
a process restart in fixtures that re-import).

Two source-of-truth modes are supported:

- ``CONFIG_SOURCE=remote`` (default, production) — fetch agent / team records
  from the central config-service over HTTPS, gated by a Keycloak
  service-account token, cached in-process with a TTL.
- ``CONFIG_SOURCE=file`` — fall back to the local ``configs/team/*.json`` and
  (optional) ``configs/agents/*.json`` directories so tests and CI run with
  no network dependency, and operators can switch a single env back to local
  files when config-service is unhealthy.

Lazy loading is always on. The only knob beyond the source flag is
``AGENT_WARM_TEAMS`` for opt-in pre-warming of known-hot teams (e.g. so MCP
servers are connected before the first request arrives).

Secrets (``KEYCLOAK_CLIENT_SECRET`` etc.) MUST come from env, never from a
JSON config — the loader's ``_check_secrets_in_json`` already enforces that
on every payload regardless of source.
"""

from __future__ import annotations

import os
from typing import Literal

#: The two source modes recognised by the lifespan. Used as a ``Literal`` so
#: ``mypy --strict`` will catch typos at call sites.
ConfigSource = Literal["remote", "file"]


def _bool_env(name: str, default: bool) -> bool:
    """Parse a boolean env var (``"true"`` / ``"false"`` / ``"1"`` / ``"0"``).

    Anything not recognised falls back to ``default`` — we intentionally do
    not raise here because settings is imported at module load time and a
    misconfigured deployment should still start far enough to log the
    problem.
    """
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"true", "1", "yes", "on"}:
        return True
    if raw in {"false", "0", "no", "off"}:
        return False
    return default


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _source_env(name: str, default: ConfigSource) -> ConfigSource:
    """Return a typed ``ConfigSource`` from the env var ``name``.

    Anything other than ``"remote"`` / ``"file"`` falls back to ``default``
    so a typo (e.g. ``REMOTEX``) does not silently disable lazy file-mode.
    """
    raw = os.environ.get(name, "").strip().lower()
    if raw == "remote":
        return "remote"
    if raw == "file":
        return "file"
    return default


class Settings:
    """Env-backed settings object.

    Read once per process at import (via the module-level ``settings``
    instance below). Tests that need to toggle a flag should monkeypatch
    the attribute on ``settings`` directly rather than re-importing — the
    constructor is the only place env is read.
    """

    def __init__(self) -> None:
        # --- feature flag: which source of truth is active ---
        # ``remote`` = config-service over HTTP (production default once
        # rolled out). ``file`` = legacy ``configs/team/*.json`` on disk
        # (testing escape hatch + CI). Both paths are lazy.
        self.CONFIG_SOURCE: ConfigSource = _source_env("CONFIG_SOURCE", "remote")

        # --- remote source ---
        # Base URL of the central config-service. Empty string disables
        # remote mode (see ``remote_enabled``) even when CONFIG_SOURCE=remote
        # so an unconfigured deployment does not crash at startup — it falls
        # through to file mode.
        self.CONFIG_SERVICE_URL: str = os.environ.get("CONFIG_SERVICE_URL", "").strip()
        self.CONFIG_CACHE_TTL: int = _int_env("CONFIG_CACHE_TTL", 60)
        self.CONFIG_CACHE_MAX_SIZE: int = _int_env("CONFIG_CACHE_MAX_SIZE", 1000)
        self.CONFIG_HTTP_TIMEOUT: float = _float_env("CONFIG_HTTP_TIMEOUT", 10.0)

        # --- Keycloak service account (mirror agent-service env names) ---
        self.KEYCLOAK_INTERNAL_ISSUER: str = os.environ.get("KEYCLOAK_INTERNAL_ISSUER", "").strip()
        self.KEYCLOAK_CLIENT_ID: str = os.environ.get("KEYCLOAK_CLIENT_ID", "").strip()
        self.KEYCLOAK_CLIENT_SECRET: str = os.environ.get("KEYCLOAK_CLIENT_SECRET", "")
        # Optional safety window applied before the actual expiry. Defaults
        # to 60 s, matching agent-service's ServiceAccountClient pattern so
        # the cached token never returns its very last second.
        self.KEYCLOAK_TOKEN_REFRESH_LEEWAY_SECONDS: int = _int_env(
            "KEYCLOAK_TOKEN_REFRESH_LEEWAY_SECONDS", 60
        )

        # --- file source (legacy + tests) ---
        # AGENT_TEAMS_DIR / AGENT_CONFIG_PATH are read by team_loader as
        # today. AGENT_AGENTS_DIR is the new parallel dir holding standalone
        # agent records for ``/projects/{pid}/agents/{aid}/invoke`` test
        # coverage. Both are optional — when neither is present file mode
        # silently produces an empty registry (no teams, no agents).
        self.AGENT_TEAMS_DIR: str = os.environ.get("AGENT_TEAMS_DIR", "").strip()
        self.AGENT_AGENTS_DIR: str = os.environ.get("AGENT_AGENTS_DIR", "").strip()

        # --- warm-up list ---
        # Comma-separated list of ``project_id/team_id`` pairs to pre-warm
        # at startup. Useful when MCP connections must be established
        # before the first request arrives. Empty (default) = pure lazy.
        self.AGENT_WARM_TEAMS: str = os.environ.get("AGENT_WARM_TEAMS", "").strip()

        # --- safety knobs ---
        # When True, an HTTPError from config-service falls back to the
        # last-known-good cached payload (if any) instead of 503ing the
        # request. R5 in the analysis doc.
        self.CONFIG_STALE_WHILE_ERROR: bool = _bool_env("CONFIG_STALE_WHILE_ERROR", True)

    # ------------------------------------------------------------------
    # Derived predicates
    # ------------------------------------------------------------------

    @property
    def remote_enabled(self) -> bool:
        """Whether remote source is both selected and configured.

        Returning ``False`` causes the lifespan to fall through to
        ``FileConfigLoader`` even when ``CONFIG_SOURCE=remote`` — this
        protects against half-configured deployments where the env flag
        was set but ``CONFIG_SERVICE_URL`` is empty.
        """
        return self.CONFIG_SOURCE == "remote" and bool(self.CONFIG_SERVICE_URL)

    @property
    def keycloak_configured(self) -> bool:
        """All three Keycloak fields must be set for client-credentials
        flow to work. When any are missing, ``service_auth`` should
        log a warning and emit an empty Authorization header (callers
        decide whether to proceed)."""
        return bool(
            self.KEYCLOAK_INTERNAL_ISSUER
            and self.KEYCLOAK_CLIENT_ID
            and self.KEYCLOAK_CLIENT_SECRET
        )

    def warm_team_entries(self) -> list[tuple[str, str]]:
        """Parse ``AGENT_WARM_TEAMS`` into ``[(project_id, team_id), ...]``.

        Format: ``project_id/team_id``, comma-separated. Whitespace is
        trimmed; malformed entries (no slash, blank ids) are silently
        dropped — the lifespan does best-effort warm-up only.
        """
        out: list[tuple[str, str]] = []
        for token in self.AGENT_WARM_TEAMS.split(","):
            token = token.strip()
            if not token or "/" not in token:
                continue
            pid, _, tid = token.partition("/")
            pid = pid.strip()
            tid = tid.strip()
            if pid and tid:
                out.append((pid, tid))
        return out


#: Module-level singleton. Import this rather than instantiating ``Settings``
#: directly so the env is parsed exactly once per process.
settings = Settings()


__all__ = ["ConfigSource", "Settings", "settings"]
