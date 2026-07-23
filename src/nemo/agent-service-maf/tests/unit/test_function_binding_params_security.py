"""Unit test — `FunctionBinding.params` security invariants.

The headline security property of function-typed tool bindings is that
the binding's ``params`` dict (deployment-pinned values: tenant ids,
kb ids, internal headers) is invisible to the LLM and reaches the
registered function *intact*, regardless of what the LLM supplies in
its arguments. The existing test_function_provider.py covers the
narrow case where the LLM tries to use ``params`` as a key (TypeError
via duplicate kwarg). This file pins the broader invariants:

  1. The function always sees the binding-pinned ``params`` exactly as
     configured, even when the LLM supplies overlapping non-``params``
     keys (e.g. an LLM passing ``kb_id="hijacked"`` when the binding
     pins ``params={"kb_id": "real"}``).
  2. The ``params`` dict passed to the function is a *copy* — a
     malicious function (or a future regression in a function we
     control) cannot mutate the binding by writing to its own
     ``params`` argument.
  3. Two concurrent calls on different bindings don't bleed ``params``
     into each other.
  4. ``FunctionBinding`` is frozen — the binding object itself cannot
     be mutated post-construction.
  5. Name validation rejects shapes that could escape the SK plugin
     namespace (path traversal, control chars, oversize).

These tests guard the boundary in `binding.py:32-` / `function_provider.py:120`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import ValidationError

from agent_service_maf.tools.binding import FunctionBinding
from agent_service_maf.tools.function_provider import (
    FunctionToolError,
    FunctionToolProvider,
)
from agent_service_maf.tools.functions import register_function

# ---------------------------------------------------------------------------
# (1) Binding-pinned params reach the function intact under overlap
# ---------------------------------------------------------------------------


class TestParamsAuthoritative:
    """The function sees the binding's `params` regardless of LLM-supplied
    keys with overlapping names. The LLM's `kb_id` becomes the function's
    positional `kb_id` argument; the binding's `params["kb_id"]` becomes
    the function's keyword-only `params["kb_id"]`. The function (and
    every caller in this repo) treats `params` as authoritative."""

    @pytest.mark.asyncio
    async def test_binding_params_intact_when_llm_supplies_overlapping_key(
        self,
    ) -> None:
        captured: dict[str, Any] = {}

        @register_function("scope_recorder")
        async def _scope_recorder(
            query: str,
            kb_id: str,
            *,
            params: dict[str, Any],
        ) -> str:
            captured["query"] = query
            captured["llm_kb_id"] = kb_id
            captured["server_params"] = dict(params)
            return "ok"

        binding = FunctionBinding(
            name="scoped_kb",
            function_ref="scope_recorder",
            params={"kb_id": "TENANT_REAL", "tenant_id": "acme"},
        )
        provider = FunctionToolProvider(bindings=[binding])

        await provider.call_tool(
            "scoped_kb",
            {"query": "hello", "kb_id": "HIJACKED_BY_LLM"},
        )

        # The function CAN see both — the LLM-supplied positional and the
        # server-pinned params — but the binding-pinned params dict is
        # what auth/scoping decisions must use, and it must be
        # *identical* to the binding's configured dict.
        assert captured["server_params"] == {
            "kb_id": "TENANT_REAL",
            "tenant_id": "acme",
        }, "binding params must reach the function unchanged"
        # The LLM's `kb_id` IS visible as the positional arg — the
        # invariant is that the function must prefer params["kb_id"]
        # over the positional. This test pins the contract that both
        # are available so the function can audit-log the discrepancy.
        assert captured["llm_kb_id"] == "HIJACKED_BY_LLM"

    @pytest.mark.asyncio
    async def test_llm_cannot_inject_params_key_via_arguments(self) -> None:
        """LLM passes a key literally named `params` → TypeError via
        duplicate-kwarg → wrapped as FunctionToolError naming the
        binding. Pinned here (also covered in test_function_provider)
        because it's the most direct attack surface."""

        @register_function("inject_attempt")
        async def _inject_attempt(*, params: dict[str, Any]) -> str:
            return f"server-params:{params}"

        binding = FunctionBinding(
            name="inject_test",
            function_ref="inject_attempt",
            params={"kb_id": "real"},
        )
        provider = FunctionToolProvider(bindings=[binding])

        with pytest.raises(FunctionToolError, match="inject_test"):
            await provider.call_tool(
                "inject_test",
                {"params": {"kb_id": "FAKE"}},
            )


# ---------------------------------------------------------------------------
# (2) The function receives a *copy* of the binding's params
# ---------------------------------------------------------------------------


class TestParamsImmutability:
    """A function that mutates its own `params` argument must not affect
    the underlying binding. `function_provider.py:120` does
    `params=dict(binding.params)` — this test pins that defensive copy."""

    @pytest.mark.asyncio
    async def test_function_mutation_does_not_affect_binding(self) -> None:
        @register_function("mutator")
        async def _mutator(*, params: dict[str, Any]) -> str:
            # Simulate a buggy or compromised function trying to
            # mutate the params it received.
            params["kb_id"] = "MUTATED"
            params["injected_key"] = "evil"
            return "done"

        binding = FunctionBinding(
            name="mut_binding",
            function_ref="mutator",
            params={"kb_id": "original", "tenant": "acme"},
        )
        provider = FunctionToolProvider(bindings=[binding])

        await provider.call_tool("mut_binding", {})

        # The binding's params dict is unchanged.
        assert binding.params == {
            "kb_id": "original",
            "tenant": "acme",
        }, "binding.params must not be mutated by a misbehaving function"

        # And a second call still sees the original values.
        captured: dict[str, Any] = {}

        @register_function("verify_after_mutator")
        async def _verifier(*, params: dict[str, Any]) -> str:
            captured["params"] = dict(params)
            return "ok"

        binding2 = FunctionBinding(
            name="mut_binding2",
            function_ref="verify_after_mutator",
            params={"kb_id": "original", "tenant": "acme"},
        )
        provider2 = FunctionToolProvider(bindings=[binding, binding2])
        await provider2.call_tool("mut_binding2", {})
        assert captured["params"] == {"kb_id": "original", "tenant": "acme"}


# ---------------------------------------------------------------------------
# (3) Concurrent calls on different bindings don't bleed params
# ---------------------------------------------------------------------------


class TestParamsConcurrentIsolation:
    """Two parallel tool calls on different bindings each see their own
    `params`. Locks the contract that no shared mutable state hides
    inside the dispatcher."""

    @pytest.mark.asyncio
    async def test_two_concurrent_bindings_see_their_own_params(self) -> None:
        seen_a: list[dict[str, Any]] = []
        seen_b: list[dict[str, Any]] = []
        # Gate to make sure both calls actually overlap in the event loop.
        gate = asyncio.Event()

        @register_function("conc_a")
        async def _conc_a(*, params: dict[str, Any]) -> str:
            seen_a.append(dict(params))
            await gate.wait()
            seen_a.append(dict(params))
            return "a-done"

        @register_function("conc_b")
        async def _conc_b(*, params: dict[str, Any]) -> str:
            seen_b.append(dict(params))
            gate.set()
            seen_b.append(dict(params))
            return "b-done"

        binding_a = FunctionBinding(name="bind_a", function_ref="conc_a", params={"kb_id": "AAA"})
        binding_b = FunctionBinding(name="bind_b", function_ref="conc_b", params={"kb_id": "BBB"})
        provider = FunctionToolProvider(bindings=[binding_a, binding_b])

        results = await asyncio.gather(
            provider.call_tool("bind_a", {}),
            provider.call_tool("bind_b", {}),
        )
        assert results == ["a-done", "b-done"]

        # Both observations on each side see the same params — no leak.
        assert seen_a == [{"kb_id": "AAA"}, {"kb_id": "AAA"}]
        assert seen_b == [{"kb_id": "BBB"}, {"kb_id": "BBB"}]


# ---------------------------------------------------------------------------
# (4) FunctionBinding immutability
# ---------------------------------------------------------------------------


class TestBindingFrozen:
    """`FunctionBinding` is `ConfigDict(frozen=True)`. Locks the
    invariant that a binding cannot be mutated after construction,
    which prevents an external attacker who reaches a binding handle
    from rewriting its params/function_ref."""

    def test_cannot_mutate_params_attribute(self) -> None:
        binding = FunctionBinding(
            name="frozen_test",
            function_ref="conc_a",
            params={"kb_id": "real"},
        )
        with pytest.raises(ValidationError):
            binding.params = {"kb_id": "evil"}  # type: ignore[misc]

    def test_cannot_mutate_function_ref(self) -> None:
        binding = FunctionBinding(
            name="frozen_test_2",
            function_ref="conc_a",
            params={},
        )
        with pytest.raises(ValidationError):
            binding.function_ref = "evil_function"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# (5) Name validation
# ---------------------------------------------------------------------------


class TestNameValidation:
    """`_NAME_PATTERN = r"^[a-zA-Z0-9_-]{1,64}$"` — locked here so any
    future loosening (e.g. allowing dots or slashes) breaks a test
    rather than silently expanding the surface for path-traversal-style
    attacks in SK plugin name slots."""

    @pytest.mark.parametrize(
        "invalid_name",
        [
            "",  # empty
            "a" * 65,  # too long
            "name with spaces",  # whitespace
            "name/with/slash",  # path traversal shape
            "name.with.dot",  # dotted shape
            "name:with:colon",  # protocol-like shape
            "name\x00null",  # NUL injection
            "name\nnewline",  # newline injection
            "name\\backslash",  # backslash
        ],
    )
    def test_invalid_names_rejected(self, invalid_name: str) -> None:
        with pytest.raises(ValidationError):
            FunctionBinding(name=invalid_name, function_ref="conc_a")

    @pytest.mark.parametrize(
        "valid_name",
        [
            "a",
            "kb_search",
            "kb-search",
            "Search123",
            "x" * 64,
            "_underscore_start",
            "-dash-start",
        ],
    )
    def test_valid_names_accepted(self, valid_name: str) -> None:
        binding = FunctionBinding(name=valid_name, function_ref="conc_a")
        assert binding.name == valid_name
