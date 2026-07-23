"""Guardrail catalog — one module per guardrail identity.

Each module defines one (or, for tightly-coupled tool guardrails, more than one)
guardrail class and registers it via the ``@GuardrailRegistry.register_*``
decorators. Phase placement (input / output / tool) is chosen in team JSON and
enforced by which decorator list a rule name resolves against — not by folder
placement.

Importing this package triggers every ``@register_*`` decorator as a side effect,
populating the registry. ``guardrails/__init__.py`` imports this package once at
startup.

Dual-phase guardrails (registered on both input and output):

- ``pii_masker``     — :class:`~agent_service_maf.guardrails.catalog.pii_masker.PIIMasker`
- ``content_filter`` — :class:`~agent_service_maf.guardrails.catalog.content_filter.ContentFilter`
- ``pci_masker``     — :class:`~agent_service_maf.guardrails.catalog.pci_masker.PCIMasker`
- ``secret_leakage`` — :class:`~...catalog.secret_leakage.SecretLeakageGuard`
- ``custom_regex``   — :class:`~agent_service_maf.guardrails.catalog.custom_regex.CustomRegexGuard`
- ``word_blocklist`` — :class:`~...catalog.word_blocklist.WordBlocklistGuard`
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Side-effect imports — fire @register_* decorators. Order is not significant
# except that every module must be imported before build_pipeline runs.
# ---------------------------------------------------------------------------
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    adversarial_unicode as _adversarial_unicode_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    content_filter as _content_filter_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    custom_regex as _custom_regex_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    input_validator as _input_validator_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    language as _language_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    output_length as _output_length_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    output_sanitizer as _output_sanitizer_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    param_validator as _param_validator_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    pci_masker as _pci_masker_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    phi_masker as _phi_masker_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    pii_masker as _pii_masker_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    prompt_injection as _prompt_injection_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    schema_validator as _schema_validator_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    secret_leakage as _secret_leakage_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    system_prompt_leakage as _system_prompt_leakage_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    tool_authorizer as _tool_authorizer_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    tool_result_guard as _tool_result_guard_module,
)
from agent_service_maf.guardrails.catalog import (  # noqa: F401
    word_blocklist as _word_blocklist_module,
)
