"""Pipeline ordering expectations for KB creation (e.g. PII before chunking)."""

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.mark.skip(
    reason="PII redaction before chunking not implemented in kb-processor "
    "(expected order: parse → redact → chunk → embed)"
)
def test_pii_redaction_runs_before_chunking_when_enabled():
    """
    Product requirement: enable PII redaction during KB creation; redact before
    chunking so unredacted content is never indexed. Dataset import supports
    enablePiiAnalysis; kb-processor has no pii/redact hooks yet.
    """
    pytest.fail("Implement PII hook in processor/temporal path and replace skip")
