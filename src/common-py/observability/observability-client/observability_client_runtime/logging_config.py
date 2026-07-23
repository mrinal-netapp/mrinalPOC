"""
Load production JSON config and apply it via configure_observability_logging.

Typical startup::

    from logging_config import configure_logging_from_json_file

    configure_logging_from_json_file("/etc/myapp/log_config.json")

Or use env::

    import os
    configure_logging_from_json_file(os.environ["LOG_CONFIG"])

Default config in repo: ``observability_client_runtime/config/log_config.json``. String values may use
``${VAR}`` or ``${VAR:-default}``; unset or empty ``VAR`` uses ``default`` when the ``:-`` form is
used. Relative ``log_file_path`` / ``trace_file_path`` resolve relative to the JSON file’s directory.

Every :class:`~observability_client_runtime.logger_handler.ObservabilityLoggingConfig` field can be set with
an environment variable ``AGENT_STUDIO_OBSERVABILITY_<NAME>`` (``NAME`` is the uppercase field name, e.g.
``AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH``). If unset, built-in defaults apply; when loading from a JSON
file, merge order is **static defaults → file → environment** (environment wins).
"""
from __future__ import annotations

import json
import os
import re
from importlib import resources
from pathlib import Path
from typing import Any

# ``${VAR}`` or ``${VAR:-default}`` in JSON string values (default used when VAR is unset or empty).
_ENV_PLACEHOLDER: re.Pattern[str] = re.compile(r"\$\{([^}:]+)(?::-([^}]*))?\}")

CONFIG_VERSION = 1

# Keys accepted by ObservabilityLoggingConfig / JSON ``logging`` section (must stay in sync)
_LOGGING_KEYS: frozenset[str] = frozenset(
    {
        "format",
        "ensure_tracer_provider",
        "enable_auto_instrumentation",
        "enable_auto_span_logging",
        "auto_span_log_level",
        "enable_red_metrics",
        "enable_openllmetry",
        "traceloop_disable_batch",
        "otlp_traces_endpoint",
        "metrics_otlp_endpoint",
        "metrics_export_interval_ms",
        "metrics_service_name",
        "prometheus_metrics_port",
        "prometheus_metrics_host",
        "min_log_level",
        "log_file_path",
        "log_file_encoding",
        "create_log_parent_dirs",
        "write_spans_to_jsonl_file",
        "trace_jsonl_filter",
        "trace_file_path",
        "trace_file_encoding",
    }
)


def _coerce_value(_key: str, value: Any) -> Any:
    """JSON null -> None."""
    if value is None:
        return None
    return value


def _expand_env_placeholders(value: Any) -> Any:
    """Replace ``${VAR}`` / ``${VAR:-default}`` in strings (bash-style ``:-``)."""

    def _sub(s: str) -> str:
        def repl(m: re.Match[str]) -> str:
            name = m.group(1).strip()
            default = m.group(2)
            if default is not None:
                env = os.environ.get(name)
                if env is None or env == "":
                    return default
                return env
            return os.environ.get(name, "")

        return _ENV_PLACEHOLDER.sub(repl, s)

    if isinstance(value, str):
        return _sub(value)
    if isinstance(value, list):
        return [_expand_env_placeholders(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand_env_placeholders(v) for k, v in value.items()}
    return value


def _coerce_logging_kwargs_types(kwargs: dict[str, Any]) -> dict[str, Any]:
    """After env expansion, JSON may only have strings; normalize types for ``ObservabilityLoggingConfig``."""
    out = dict(kwargs)

    def _bool(v: Any) -> bool:
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            s = v.strip().lower()
            if s in ("true", "1", "yes", "on"):
                return True
            if s in ("false", "0", "no", "off"):
                return False
        raise ValueError(f"Expected boolean, got {v!r}")

    def _opt_int(v: Any) -> int | None:
        if v is None or (isinstance(v, str) and v.strip() == ""):
            return None
        if isinstance(v, bool):
            raise ValueError(f"Expected int or null, got {v!r}")
        return int(v) if not isinstance(v, int) else v

    def _req_int(v: Any) -> int:
        if isinstance(v, bool):
            raise ValueError(f"Expected int, got {v!r}")
        return int(v) if not isinstance(v, int) else v

    bool_keys = (
        "ensure_tracer_provider",
        "enable_auto_instrumentation",
        "enable_auto_span_logging",
        "enable_red_metrics",
        "enable_openllmetry",
        "traceloop_disable_batch",
        "create_log_parent_dirs",
        "write_spans_to_jsonl_file",
    )
    for k in bool_keys:
        if k in out and out[k] is not None:
            out[k] = _bool(out[k])

    if "metrics_export_interval_ms" in out and out["metrics_export_interval_ms"] is not None:
        out["metrics_export_interval_ms"] = _req_int(out["metrics_export_interval_ms"])

    if "prometheus_metrics_port" in out:
        out["prometheus_metrics_port"] = _opt_int(out["prometheus_metrics_port"])

    return out


def _build_kwargs(logging_cfg: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    for key in _LOGGING_KEYS:
        if key not in logging_cfg:
            continue
        kwargs[key] = _coerce_value(key, logging_cfg[key])
    return kwargs


def _resolve_log_file_path(config_path: Path, log_file_path: str | Path | None) -> str | Path | None:
    """Relative paths are resolved against the directory containing the JSON config file."""
    if log_file_path is None:
        return None
    p = Path(log_file_path)
    if p.is_absolute():
        return p
    return (config_path.parent / p).resolve()


def load_logging_config_dict(raw: dict[str, Any]) -> dict[str, Any]:
    """
    Parse a config dict (e.g. from json.load) and return kwargs for ``ObservabilityLoggingConfig``.

    Expected shape::

        { \"version\": 1, \"logging\": { ... } }

    If ``logging`` is omitted, top-level keys (except ``version``) are treated as logging options.
    """
    version = raw.get("version", CONFIG_VERSION)
    if version != CONFIG_VERSION:
        raise ValueError(
            f"Unsupported logging config version {version!r}; "
            f"expected {CONFIG_VERSION}"
        )

    if "logging" in raw and isinstance(raw["logging"], dict):
        logging_cfg = raw["logging"]
    else:
        logging_cfg = {k: v for k, v in raw.items() if k != "version"}

    unknown = set(logging_cfg.keys()) - _LOGGING_KEYS
    if unknown:
        raise ValueError(f"Unknown logging config keys: {sorted(unknown)}")

    expanded = {k: _expand_env_placeholders(v) for k, v in logging_cfg.items()}
    kwargs = _build_kwargs(expanded)
    return _coerce_logging_kwargs_types(kwargs)


def configure_logging_from_json_file(path: str | Path, *, encoding: str = "utf-8") -> None:
    """
    Read JSON from ``path`` and call configure_observability_logging with the ``logging`` section.

    Merge order: built-in defaults, then JSON values, then ``AGENT_STUDIO_OBSERVABILITY_*`` environment
    variables (env wins). Relative ``log_file_path`` / ``trace_file_path`` in JSON are resolved
    against the directory containing this JSON file.

    Raises:
        FileNotFoundError: if path does not exist
        ValueError: on unknown keys or unsupported version
    """
    from .logger_handler import (
        ObservabilityLoggingConfig,
        configure_observability_logging,
        observability_env_overrides,
        observability_static_defaults,
    )

    path = Path(path).resolve()
    raw = json.loads(path.read_text(encoding=encoding))
    kwargs = load_logging_config_dict(raw)
    merged = {**observability_static_defaults(), **kwargs, **observability_env_overrides()}
    merged["log_file_path"] = _resolve_log_file_path(path, merged.get("log_file_path"))
    merged["trace_file_path"] = _resolve_log_file_path(path, merged.get("trace_file_path"))
    configure_observability_logging(config=ObservabilityLoggingConfig(**merged))


def configure_logging_from_packaged_default(*, encoding: str = "utf-8") -> None:
    """
    Load the default JSON config bundled with the installed package.

    This keeps JSON-based configuration available after ``pip install`` without requiring
    repo-local paths. Merge order matches :func:`configure_logging_from_json_file` (defaults → JSON →
    ``AGENT_STUDIO_OBSERVABILITY_*``). Relative paths in the packaged JSON resolve against the packaged
    ``config/`` directory.
    """
    from .logger_handler import (
        ObservabilityLoggingConfig,
        configure_observability_logging,
        observability_env_overrides,
        observability_static_defaults,
    )

    config_path = Path(__file__).resolve().parent / "config" / "log_config.json"
    raw_text = resources.files("observability_client_runtime").joinpath("config/log_config.json").read_text(
        encoding=encoding
    )
    raw = json.loads(raw_text)
    kwargs = load_logging_config_dict(raw)
    merged = {**observability_static_defaults(), **kwargs, **observability_env_overrides()}
    merged["log_file_path"] = _resolve_log_file_path(config_path, merged.get("log_file_path"))
    merged["trace_file_path"] = _resolve_log_file_path(config_path, merged.get("trace_file_path"))
    configure_observability_logging(config=ObservabilityLoggingConfig(**merged))


def configure_logging_from_env(
    env_var: str = "LOG_CONFIG",
    *,
    default_path: str | Path | None = None,
    use_packaged_default: bool = False,
) -> None:
    """
    If ``env_var`` is set, load that JSON path. Else if ``default_path`` is set, load it.
    Else if ``use_packaged_default`` is True, load packaged defaults from installed package data.
    If none of the above apply, does nothing (caller may call ``configure_observability_logging``
    with a default ``ObservabilityLoggingConfig()`` or another instance).
    """
    p = os.environ.get(env_var)
    if p:
        configure_logging_from_json_file(p)
        return
    if default_path is not None:
        configure_logging_from_json_file(default_path)
        return
    if use_packaged_default:
        configure_logging_from_packaged_default()


__all__ = (
    "CONFIG_VERSION",
    "configure_logging_from_env",
    "configure_logging_from_json_file",
    "configure_logging_from_packaged_default",
    "load_logging_config_dict",
)

