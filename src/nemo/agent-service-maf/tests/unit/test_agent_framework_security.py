"""Behavior tests for ``agent_framework.security`` (FIDES experimental).

``security.py`` ships ~700 statements covering content labels, the variable
store for untrusted-content indirection, ``LabeledMessage``, and the
``inspect_variable`` / ``store_untrusted_content`` security tools. Our
existing tests don't import any of it, so the module sits at 20% coverage.

These tests exercise the data-model surface (no network, no LLM): label
construction, label combination, the variable store CRUD, the labeled
message role-inference matrix, the quarantine-client setter/getter pair,
and the ``inspect_variable`` happy-path + missing-id branches.

Coverage uplift target: ``security.py`` 20% → ~50%.
"""

from __future__ import annotations

import asyncio

import pytest
from agent_framework.security import (
    ConfidentialityLabel,
    ContentLabel,
    ContentVariableStore,
    IntegrityLabel,
    LabeledMessage,
    VariableReferenceContent,
    check_confidentiality_allowed,
    combine_labels,
    get_quarantine_client,
    get_security_tools,
    get_variable_store,
    inspect_variable,
    set_quarantine_client,
    set_variable_store,
    store_untrusted_content,
)

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


def test_integrity_label_str_roundtrip() -> None:
    assert str(IntegrityLabel.TRUSTED) == "trusted"
    assert str(IntegrityLabel.UNTRUSTED) == "untrusted"


def test_confidentiality_label_str_roundtrip() -> None:
    assert str(ConfidentialityLabel.PUBLIC) == "public"
    assert str(ConfidentialityLabel.PRIVATE) == "private"
    assert str(ConfidentialityLabel.USER_IDENTITY) == "user_identity"


# ---------------------------------------------------------------------------
# ContentLabel
# ---------------------------------------------------------------------------


def test_content_label_defaults() -> None:
    label = ContentLabel()
    assert label.integrity == IntegrityLabel.TRUSTED
    assert label.confidentiality == ConfidentialityLabel.PUBLIC
    assert label.is_trusted() is True
    assert label.is_public() is True
    assert "ContentLabel" in repr(label)


def test_content_label_from_string_values_coerces_to_enum() -> None:
    # Constructor accepts raw strings; verifies the coercion branches run.
    label = ContentLabel(integrity="untrusted", confidentiality="private")  # type: ignore[arg-type]
    assert label.integrity == IntegrityLabel.UNTRUSTED
    assert label.confidentiality == ConfidentialityLabel.PRIVATE
    assert label.is_trusted() is False


def test_content_label_to_dict_includes_metadata_when_present() -> None:
    label = ContentLabel(metadata={"user_id": "u1"})
    payload = label.to_dict()
    assert payload["integrity"] == "trusted"
    assert payload["confidentiality"] == "public"
    assert payload["metadata"] == {"user_id": "u1"}


def test_content_label_to_dict_omits_metadata_when_empty() -> None:
    payload = ContentLabel().to_dict()
    assert "metadata" not in payload


def test_content_label_from_dict_handles_missing_keys() -> None:
    # Missing keys fall back to TRUSTED/PUBLIC defaults.
    label = ContentLabel.from_dict({})
    assert label.integrity == IntegrityLabel.TRUSTED
    assert label.confidentiality == ConfidentialityLabel.PUBLIC


# ---------------------------------------------------------------------------
# combine_labels
# ---------------------------------------------------------------------------


def test_combine_labels_no_inputs_returns_default() -> None:
    label = combine_labels()
    assert label.integrity == IntegrityLabel.TRUSTED
    assert label.confidentiality == ConfidentialityLabel.PUBLIC


def test_combine_labels_any_untrusted_taints_result() -> None:
    a = ContentLabel(integrity=IntegrityLabel.TRUSTED)
    b = ContentLabel(integrity=IntegrityLabel.UNTRUSTED)
    combined = combine_labels(a, b)
    assert combined.integrity == IntegrityLabel.UNTRUSTED


def test_combine_labels_picks_most_restrictive_confidentiality() -> None:
    public = ContentLabel(confidentiality=ConfidentialityLabel.PUBLIC)
    private = ContentLabel(confidentiality=ConfidentialityLabel.PRIVATE)
    user_id = ContentLabel(confidentiality=ConfidentialityLabel.USER_IDENTITY)
    assert combine_labels(public, private).confidentiality == ConfidentialityLabel.PRIVATE
    assert combine_labels(public, user_id).confidentiality == ConfidentialityLabel.USER_IDENTITY
    assert combine_labels(private, user_id).confidentiality == ConfidentialityLabel.USER_IDENTITY


def test_combine_labels_merges_metadata() -> None:
    a = ContentLabel(metadata={"k1": "a"})
    b = ContentLabel(metadata={"k2": "b"})
    combined = combine_labels(a, b)
    assert combined.metadata == {"k1": "a", "k2": "b"}


# ---------------------------------------------------------------------------
# check_confidentiality_allowed
# ---------------------------------------------------------------------------


def test_check_confidentiality_allowed_writes_within_limit() -> None:
    public_ctx = ContentLabel(confidentiality=ConfidentialityLabel.PUBLIC)
    # PUBLIC content to any destination is fine.
    assert check_confidentiality_allowed(public_ctx, ConfidentialityLabel.PUBLIC) is True
    assert check_confidentiality_allowed(public_ctx, ConfidentialityLabel.PRIVATE) is True


def test_check_confidentiality_allowed_blocks_exfiltration() -> None:
    # PRIVATE → PUBLIC destination must be blocked.
    private_ctx = ContentLabel(confidentiality=ConfidentialityLabel.PRIVATE)
    assert check_confidentiality_allowed(private_ctx, ConfidentialityLabel.PUBLIC) is False


# ---------------------------------------------------------------------------
# ContentVariableStore
# ---------------------------------------------------------------------------


def test_variable_store_round_trip() -> None:
    store = ContentVariableStore()
    label = ContentLabel(integrity=IntegrityLabel.UNTRUSTED)
    var_id = store.store("secret-payload", label)
    assert store.exists(var_id) is True
    content, retrieved = store.retrieve(var_id)
    assert content == "secret-payload"
    assert retrieved.integrity == IntegrityLabel.UNTRUSTED


def test_variable_store_retrieve_raises_for_unknown_id() -> None:
    with pytest.raises(KeyError):
        ContentVariableStore().retrieve("nope")


def test_variable_store_list_and_clear() -> None:
    store = ContentVariableStore()
    store.store("a", ContentLabel())
    store.store("b", ContentLabel())
    assert len(store.list_variables()) == 2
    store.clear()
    assert store.list_variables() == []


# ---------------------------------------------------------------------------
# VariableReferenceContent
# ---------------------------------------------------------------------------


def test_variable_reference_content_to_dict_and_back() -> None:
    label = ContentLabel(integrity=IntegrityLabel.UNTRUSTED)
    ref = VariableReferenceContent("var_xyz", label, description="external")
    assert "VariableReferenceContent" in repr(ref)
    payload = ref.to_dict()
    assert payload["variable_id"] == "var_xyz"
    assert payload["type"] == "variable_reference"
    assert payload["description"] == "external"

    restored = VariableReferenceContent.from_dict(payload)
    assert restored.variable_id == "var_xyz"
    assert restored.description == "external"
    assert restored.label.integrity == IntegrityLabel.UNTRUSTED


def test_variable_reference_from_dict_accepts_legacy_label_key() -> None:
    payload = {
        "variable_id": "var_abc",
        "label": {"integrity": "trusted", "confidentiality": "public"},
    }
    ref = VariableReferenceContent.from_dict(payload)
    assert ref.variable_id == "var_abc"


# ---------------------------------------------------------------------------
# LabeledMessage role inference matrix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "role,expected_integrity",
    [
        ("user", IntegrityLabel.TRUSTED),
        ("system", IntegrityLabel.TRUSTED),
        ("assistant", IntegrityLabel.TRUSTED),  # no sources → TRUSTED
        ("tool", IntegrityLabel.UNTRUSTED),
        ("weird-role", IntegrityLabel.UNTRUSTED),  # unknown role
    ],
)
def test_labeled_message_infers_label_from_role(
    role: str, expected_integrity: IntegrityLabel
) -> None:
    msg = LabeledMessage(role=role, content="hello")
    assert msg.security_label.integrity == expected_integrity


def test_labeled_message_assistant_inherits_source_labels() -> None:
    untrusted_source = ContentLabel(integrity=IntegrityLabel.UNTRUSTED)
    msg = LabeledMessage(
        role="assistant",
        content="summary",
        source_labels=[untrusted_source],
    )
    # Assistant should inherit UNTRUSTED from its source.
    assert msg.security_label.integrity == IntegrityLabel.UNTRUSTED


def test_labeled_message_is_trusted_helper() -> None:
    trusted_msg = LabeledMessage(role="user", content="hi")
    assert trusted_msg.is_trusted() is True
    untrusted_msg = LabeledMessage(role="tool", content="result")
    assert untrusted_msg.is_trusted() is False


def test_labeled_message_explicit_label_overrides_inference() -> None:
    override = ContentLabel(integrity=IntegrityLabel.UNTRUSTED)
    # User role normally infers TRUSTED, but explicit override wins.
    msg = LabeledMessage(role="user", content="hi", security_label=override)
    assert msg.security_label.integrity == IntegrityLabel.UNTRUSTED


def test_labeled_message_accepts_list_and_none_content() -> None:
    msg = LabeledMessage(role="user", content=["part1", "part2"])
    assert msg.role == "user"
    # None content → empty contents list, no crash.
    msg2 = LabeledMessage(role="system", content=None)
    assert msg2.role == "system"


def test_labeled_message_repr_includes_label() -> None:
    msg = LabeledMessage(role="user", content="hi")
    text = repr(msg)
    assert "LabeledMessage" in text
    assert "trusted" in text


# ---------------------------------------------------------------------------
# Module-level helpers: store_untrusted_content, variable_store, security tools
# ---------------------------------------------------------------------------


def test_store_untrusted_content_uses_global_store() -> None:
    ref = store_untrusted_content("payload", description="api response")
    assert ref.variable_id.startswith("var_")
    assert ref.label.integrity == IntegrityLabel.UNTRUSTED
    # The reference points into the global store.
    store = get_variable_store()
    assert store.exists(ref.variable_id)


def test_set_variable_store_replaces_global() -> None:
    original = get_variable_store()
    try:
        replacement = ContentVariableStore()
        set_variable_store(replacement)
        assert get_variable_store() is replacement
    finally:
        # Restore the original to avoid polluting other tests.
        set_variable_store(original)


def test_get_security_tools_returns_two_function_tools() -> None:
    tools = get_security_tools()
    # quarantined_llm + inspect_variable
    assert len(tools) == 2
    names = {getattr(t, "name", None) for t in tools}
    assert "inspect_variable" in names or any("inspect" in str(t) for t in tools)


def test_quarantine_client_setter_and_getter() -> None:
    # Bookend with the existing client so we don't pollute global state.
    previous = get_quarantine_client()
    try:
        set_quarantine_client(None)
        assert get_quarantine_client() is None
    finally:
        set_quarantine_client(previous)


# ---------------------------------------------------------------------------
# inspect_variable tool
# ---------------------------------------------------------------------------


def _await(coro):  # type: ignore[no-untyped-def]
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.mark.asyncio
async def test_inspect_variable_returns_content_for_known_id() -> None:
    ref = store_untrusted_content("hidden text", description="trace")
    result = await inspect_variable.func(variable_id=ref.variable_id, reason="audit test")  # type: ignore[attr-defined]
    assert result["variable_id"] == ref.variable_id
    assert result["content"] == "hidden text"
    assert "warning" in result
    assert result["inspected"] is True


@pytest.mark.asyncio
async def test_inspect_variable_unknown_id_returns_error_dict() -> None:
    result = await inspect_variable.func(variable_id="var_does_not_exist", reason=None)  # type: ignore[attr-defined]
    assert result["variable_id"] == "var_does_not_exist"
    assert "error" in result
    assert result["security_label"] is None
