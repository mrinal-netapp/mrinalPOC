"""3-tier configuration loader: env vars → JSON file → request overrides.

Priority (later wins):
  1. Defaults — from :data:`~agent_service_maf.config.defaults.DEFAULTS`
  2. Environment variables — ``AGENT_`` prefix, ``__`` for nesting
  3. JSON config file — ``configs/agent_config.json`` by default
  4. Request payload overrides — per-invocation overrides (highest priority)

Environment variable convention:
  - Prefix: ``AGENT_``
  - Nesting separator: double underscore (``__``)
  - Values are parsed as JSON where possible (booleans, numbers, lists)
    and fall back to plain strings.
  - Examples:
    - ``AGENT_AGENT__MODEL=anthropic/claude-haiku-4-20250414``
      → ``{"agent": {"model": "anthropic/claude-haiku-4-20250414"}}``
    - ``AGENT_INTERFACE__PORT=9000``
      → ``{"interface": {"port": 9000}}``
    - ``AGENT_INTERFACE__AUTH__ENABLED=true``
      → ``{"interface": {"auth": {"enabled": True}}}``
    - ``AGENT_INTERFACE__AUTH__API_KEYS=["sk-abc","sk-def"]``
      → ``{"interface": {"auth": {"api_keys": ["sk-abc", "sk-def"]}}}``
    - ``AGENT_GUARDRAILS__ENABLED=false``
      → ``{"guardrails": {"enabled": False}}``
    - ``AGENT_MCP__TOOL_CALL_TIMEOUT_SECONDS=120``
      → ``{"mcp": {"tool_call_timeout_seconds": 120}}``

Security rules enforced by this module:
  - Secret fields (ending in ``_key``, ``_secret``, ``_token``) MUST be empty
    in the JSON config file. Non-empty values raise
    :class:`~agent_service_maf.core.exceptions.ConfigurationError`.
  - Locked fields (``agent.framework``, ``project_id``) cannot be overridden
    in request payloads. Attempts raise
    :class:`~agent_service_maf.core.exceptions.ConfigurationError`.
"""

from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Any

import structlog

from agent_service_maf.config.defaults import DEFAULTS
from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.exceptions import ConfigurationError

logger = structlog.get_logger(__name__)

#: Fields whose values come only from env vars / JSON at server start.
#: Attempts to override these in a per-request ``config_overrides`` dict will
#: raise :class:`~agent_service_maf.core.exceptions.ConfigurationError`.
_LOCKED_FIELDS: frozenset[str] = frozenset(AgentConfig.model_fields["locked_fields"].default)

#: Suffixes that mark a field as a secret.  Any field whose name ends with one
#: of these strings must be empty in the JSON config file.
_SECRET_SUFFIXES: tuple[str, ...] = ("_key", "_secret", "_token")


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge *override* into *base* and return a new dict.

    Merge rules:
    - ``dict`` values are merged recursively (keys from both sides are kept).
    - ``list`` values in *override* **replace** the corresponding list in
      *base* entirely (no appending).
    - ``None`` values in *override* are **skipped** — they do not overwrite
      the corresponding value in *base*.
    - All values are **deep-copied** so neither *base* nor *override* is
      mutated by this call.

    Args:
        base: The lower-priority dict. Values here are the starting point.
        override: The higher-priority dict. Values here win over *base*.

    Returns:
        A new dict that is the deep-merged result.

    Example:
        >>> deep_merge({"a": {"x": 1, "y": 2}}, {"a": {"y": 99, "z": 3}})
        {'a': {'x': 1, 'y': 99, 'z': 3}}
        >>> deep_merge({"tags": ["a", "b"]}, {"tags": ["c"]})
        {'tags': ['c']}
        >>> deep_merge({"port": 8000}, {"port": None})
        {'port': 8000}
    """
    result = deepcopy(base)
    for key, value in override.items():
        if value is None:
            # None in override means "leave base value unchanged"
            continue
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def _check_secrets_in_json(data: dict[str, Any], path: str = "") -> None:
    """Recursively verify that no secret fields have non-empty values in *data*.

    A field is considered a secret if its name ends with ``_key``,
    ``_secret``, or ``_token``.

    Args:
        data: The parsed JSON dict (or a nested sub-dict).
        path: Dot-separated path to the current sub-dict (for error messages).

    Raises:
        ConfigurationError: If a secret field contains a non-empty value.
    """
    for key, value in data.items():
        full_path = f"{path}.{key}" if path else key
        if isinstance(value, dict):
            _check_secrets_in_json(value, full_path)
        elif (
            isinstance(key, str)
            and key.endswith(_SECRET_SUFFIXES)
            and isinstance(value, str)
            and value not in ("", None)
        ):
            raise ConfigurationError(
                f"Secret field '{full_path}' must be empty in JSON config files. "
                f"Secrets must come from environment variables, not config files. "
                f"Use the corresponding AGENT_{full_path.upper().replace('.', '__')} "
                f"environment variable instead.",
                details={"field": full_path},
            )


def _check_locked_fields(overrides: dict[str, Any], prefix: str = "") -> None:
    """Recursively check *overrides* for locked field violations.

    A locked field path (e.g. ``agent.framework``) cannot be present in a
    per-request ``config_overrides`` dict.

    Args:
        overrides: The request override dict (or a nested sub-dict).
        prefix: Dot-separated path built up during recursion.

    Raises:
        ConfigurationError: If a locked field is found in *overrides*.
    """
    for key, value in overrides.items():
        full_path = f"{prefix}.{key}" if prefix else key
        if full_path in _LOCKED_FIELDS:
            raise ConfigurationError(
                f"Field '{full_path}' is locked and cannot be overridden per-request. "
                f"This field is fixed at server startup via the JSON config file or "
                f"the AGENT_{full_path.upper().replace('.', '__')} environment variable. "
                f"To change it, update the server configuration and restart.",
                details={"locked_field": full_path},
            )
        if isinstance(value, dict):
            _check_locked_fields(value, full_path)


class ConfigLoader:
    """Loads and merges configuration from three tiers.

    Priority (lowest to highest):
      1. :data:`~agent_service_maf.config.defaults.DEFAULTS`
      2. Environment variables (``AGENT_`` prefix)
      3. JSON config file *or* an in-memory dict (``json_config_data``)
      4. Per-request overrides passed to :meth:`resolve`

    Usage (file source):
        >>> loader = ConfigLoader(json_config_path="configs/agent_config.json")
        >>> config = loader.resolve()
        >>> config = loader.resolve({"agent": {"temperature": 0.2}})

    Usage (remote/in-memory source — config-service migration):
        >>> payload = await remote_cache.get_team(pid, tid)
        >>> loader = ConfigLoader(json_config_data=payload)
        >>> config = loader.resolve()

    Both code paths share the same locked-field check, secret-in-JSON
    check, env merge, and Pydantic validation — only the *source* of the
    JSON tier differs.

    Args:
        json_config_path: Path to the JSON config file. If ``None`` or the
            file does not exist, this tier is silently skipped (a warning
            is logged when the file is explicitly set but missing).
            Ignored when ``json_config_data`` is supplied.
        env_prefix: Prefix for environment variables. Defaults to ``"AGENT_"``.
        json_config_data: Pre-fetched JSON payload (e.g. from the
            config-service cache). When non-None this dict is used as the
            JSON tier verbatim — ``json_config_path`` is ignored. The dict
            is run through ``_check_secrets_in_json`` exactly like a
            file-loaded payload would be, so a remote source can never
            smuggle a secret past the loader.
    """

    def __init__(
        self,
        json_config_path: str | Path | None = None,
        env_prefix: str = "AGENT_",
        *,
        json_config_data: dict[str, Any] | None = None,
    ) -> None:
        """Initialise the loader.

        Args:
            json_config_path: Optional path to a JSON config file.
            env_prefix: Environment variable prefix (default ``"AGENT_"``).
            json_config_data: Pre-fetched JSON payload that replaces the
                file source. When provided, ``json_config_path`` is
                ignored.
        """
        # Preserve ``json_config_path`` even when ``json_config_data`` is
        # supplied. ``_load_from_json`` prefers the in-memory override,
        # so the path is purely a fallback; keeping it means
        # :meth:`update_json_data` can ``update_json_data(None)`` to drop
        # back to the file source as the docstring promises. Previously
        # the path was nulled whenever ``json_config_data`` was set,
        # making that fallback impossible and producing surprising
        # ``None`` paths in logs.
        self.json_config_path: Path | None = Path(json_config_path) if json_config_path else None
        self.env_prefix: str = env_prefix
        self._json_cache: dict[str, Any] | None = None
        # In-memory payload override. Stored as a deepcopy so the caller's
        # dict cannot mutate the loader's view of the JSON tier between
        # resolve() calls — this matches the contract of file-loaded data
        # (we read the file once and treat the parsed dict as immutable).
        self._json_data_override: dict[str, Any] | None = (
            deepcopy(json_config_data) if json_config_data is not None else None
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def resolve(
        self,
        request_overrides: dict[str, Any] | None = None,
    ) -> AgentConfig:
        """Resolve the final merged configuration.

        Performs a 4-step deep merge in priority order:

        1. Start with :data:`~agent_service_maf.config.defaults.DEFAULTS`.
        2. Merge environment variables (Tier 1 — env < json < request).
        3. Merge JSON config file values (Tier 2).
        4. Merge per-request overrides (Tier 3 — highest priority).

        Before applying *request_overrides*, locked fields are validated.
        The merged dict is then passed to :class:`~agent_service_maf.config.validators.AgentConfig`
        for Pydantic validation.

        Args:
            request_overrides: Dict of config values from the request payload.
                Only non-locked fields may be overridden. Pass ``None`` or an
                empty dict to skip this tier.

        Returns:
            A validated, frozen :class:`~agent_service_maf.config.validators.AgentConfig`.

        Raises:
            ConfigurationError: If a locked field is in *request_overrides*,
                if the JSON file contains non-empty secret fields, or if the
                merged result fails Pydantic validation.

        Example:
            >>> loader = ConfigLoader("configs/agent_config.json")
            >>> cfg = loader.resolve({"agent": {"temperature": 0.1}})
            >>> cfg.agent.temperature
            0.1
        """
        # Enforce locked fields BEFORE merging to give a clear error early.
        if request_overrides:
            _check_locked_fields(request_overrides)

        # Build merged config in priority order (later wins).
        merged: dict[str, Any] = deepcopy(DEFAULTS)

        env_config = self._load_from_env()
        if env_config:
            merged = deep_merge(merged, env_config)
            logger.debug("Merged env config", env_keys=sorted(env_config.keys()))

        json_config = self._load_from_json()
        if json_config:
            merged = deep_merge(merged, json_config)
            logger.debug("Merged JSON config", path=str(self.json_config_path))

        if request_overrides:
            merged = deep_merge(merged, request_overrides)
            logger.debug(
                "Merged request overrides",
                override_keys=sorted(request_overrides.keys()),
            )

        try:
            return AgentConfig(**merged)
        except Exception as exc:
            raise ConfigurationError(
                f"Configuration validation failed: {exc}. "
                f"Check the merged configuration against the schema in "
                f"configs/agent_config.reference.yaml.",
                details={"merged_config": merged, "validation_error": str(exc)},
            ) from exc

    def reload_json(self) -> None:
        """Clear the JSON config cache.

        The next call to :meth:`resolve` will re-read the JSON file from disk
        (or re-run the secret check on the in-memory payload, in remote mode).
        Useful for config hot-reload or testing with different file contents.
        """
        self._json_cache = None
        logger.debug(
            "JSON config cache cleared",
            path=str(self.json_config_path) if self.json_config_path else None,
            in_memory=self._json_data_override is not None,
        )

    def update_json_data(self, payload: dict[str, Any] | None) -> None:
        """Replace the in-memory JSON tier with a fresh payload.

        Used by the lazy registry when a TTL refresh on the config-service
        cache yields a new dict for an already-loaded team. The next call
        to :meth:`resolve` will re-run the secret-in-JSON check on the new
        payload and re-merge with env + request overrides.

        Args:
            payload: The new pre-fetched JSON payload, or ``None`` to drop
                back to ``json_config_path`` if one was set.
        """
        self._json_data_override = deepcopy(payload) if payload is not None else None
        # Re-running the secret check on the next resolve() is required —
        # invalidate the cached parsed dict so we don't accidentally serve
        # the old payload.
        self._json_cache = None

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _load_from_env(self) -> dict[str, Any]:
        """Parse environment variables with the configured prefix into a dict.

        Convention:
        - Strip the prefix (e.g. ``AGENT_``).
        - Split on ``__`` (double underscore) to produce nested keys.
        - Convert to lowercase.
        - Try ``json.loads()`` first for numbers, booleans, and lists;
          fall back to plain string.
        - Variables without at least one ``__`` separator (i.e. not nested)
          are silently ignored — they don't follow the naming convention.
        - Variables whose first path component is not a recognised top-level
          config section are silently ignored, preventing accidental pollution
          from unrelated ``AGENT_*`` environment variables.

        Examples:
            ``AGENT_AGENT__MODEL=gpt-4o``
                → ``{"agent": {"model": "gpt-4o"}}``

            ``AGENT_INTERFACE__PORT=9000``
                → ``{"interface": {"port": 9000}}``

            ``AGENT_GUARDRAILS__ENABLED=false``
                → ``{"guardrails": {"enabled": False}}``

            ``AGENT_INTERFACE__AUTH__API_KEYS=["sk-a","sk-b"]``
                → ``{"interface": {"auth": {"api_keys": ["sk-a", "sk-b"]}}}``

        Returns:
            A (possibly empty) nested dict of config values from env vars.
        """
        config: dict[str, Any] = {}
        prefix_len = len(self.env_prefix)
        # Recognised top-level section names from the schema.
        known_sections: frozenset[str] = frozenset(AgentConfig.model_fields.keys())

        for raw_key, raw_value in os.environ.items():
            if not raw_key.startswith(self.env_prefix):
                continue

            stripped = raw_key[prefix_len:]

            # Require at least one __ separator (nesting convention).
            if "__" not in stripped:
                continue

            # Strip prefix, lowercase, split on double underscore.
            parts = stripped.lower().split("__")

            # Ignore variables whose top-level section is unknown.
            if parts[0] not in known_sections:
                logger.debug(
                    "Skipping unrecognised env var",
                    env_var=raw_key,
                    section=parts[0],
                )
                continue

            # Navigate / create nested dicts.
            current: dict[str, Any] = config
            for part in parts[:-1]:
                current = current.setdefault(part, {})

            # Parse value: JSON first (handles bool, int, float, list), then str.
            leaf_key = parts[-1]
            try:
                current[leaf_key] = json.loads(raw_value)
            except (json.JSONDecodeError, ValueError):
                current[leaf_key] = raw_value

        return config

    def _load_from_json(self) -> dict[str, Any]:
        """Load and cache the JSON config data.

        Two sources are supported (mutually exclusive — ``json_config_data``
        in the constructor wins):

        1. **In-memory payload** (remote/config-service mode). Already
           parsed; we still re-run :func:`_check_secrets_in_json` so a
           remote source can never smuggle a secret past the loader.
        2. **File on disk** (legacy / file mode). Read once and cached so
           per-request :meth:`resolve` calls do not re-read the file.

        If neither source is configured, returns an empty dict (defaults +
        env only). If the file does not exist, logs a warning and returns
        an empty dict.

        Returns:
            A (possibly empty) dict of config values from the JSON tier.

        Raises:
            ConfigurationError: If the source is invalid JSON or contains
                non-empty secret fields.
        """
        # In-memory payload path (config-service migration). Cached on the
        # first resolve() so the secret check runs exactly once per loader
        # — same number of validations as the file path. ``reload_json``
        # / ``update_json_data`` clears the cache when the payload churns.
        if self._json_data_override is not None:
            if self._json_cache is not None:
                return self._json_cache
            _check_secrets_in_json(self._json_data_override)
            self._json_cache = self._json_data_override
            return self._json_cache

        if self.json_config_path is None:
            return {}

        if self._json_cache is not None:
            return self._json_cache

        if not self.json_config_path.exists():
            logger.warning(
                "JSON config file not found; using defaults + env only",
                path=str(self.json_config_path),
            )
            return {}

        try:
            with open(self.json_config_path) as fh:
                data: dict[str, Any] = json.load(fh)
        except json.JSONDecodeError as exc:
            raise ConfigurationError(
                f"Invalid JSON in config file '{self.json_config_path}': {exc}. "
                f"Validate the file with 'python -m json.tool {self.json_config_path}'.",
                details={"path": str(self.json_config_path), "error": str(exc)},
            ) from exc

        # Security: reject secrets stored in the JSON file.
        _check_secrets_in_json(data)

        self._json_cache = data
        return self._json_cache
