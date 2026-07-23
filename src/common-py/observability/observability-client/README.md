# agentstudio-observability-client-runtime

AgentStudio Python observability client runtime: structured logging (structlog),
OpenTelemetry traces, metrics (Prometheus + OTLP), HTTP middleware, and optional
OpenLLMetry (Traceloop) integration.

## Install

```bash
pip install -e .
```

## Quick start

```python
from observability_client_runtime.logging_config import configure_logging_from_env
from observability_client_runtime.logger_handler import get_logger

configure_logging_from_env(use_packaged_default=True)
logger = get_logger()
logger.info("service_started")
```
