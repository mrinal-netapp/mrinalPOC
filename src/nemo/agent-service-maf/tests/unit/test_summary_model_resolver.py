"""Unit tests for ``_resolve_summary_model`` — the fallback chain that
picks which model the summary buffer calls when ``summary_model`` is
unset on the team.

Without this resolver, the summary path falls back to
``config.gateway.default_model`` (a static default like
``anthropic/claude-...``) which often doesn't match any provider Bifrost
has registered for the cluster — every summary call then fails with
``provider: not found`` even though the team's actual agent invokes
succeed because they use the resolved per-agent ``gatewayModelId``.
"""

from __future__ import annotations

from types import SimpleNamespace

from agent_service_maf.core.team_loader import _resolve_summary_model


def _cfg(*, agents=None, agent_default="", gateway_default="") -> SimpleNamespace:
    sk = SimpleNamespace(agents=agents or [])
    return SimpleNamespace(
        semantic_kernel=sk,
        agent=SimpleNamespace(model=agent_default),
        gateway=SimpleNamespace(default_model=gateway_default),
    )


class TestResolveSummaryModel:
    def test_explicit_summary_model_wins(self) -> None:
        mem = SimpleNamespace(summary_model="azure/explicit-model")
        cfg = _cfg(
            agents=[SimpleNamespace(model="azure/gpt-5.4")],
            agent_default="anthropic/claude-sonnet-4-20250514",
            gateway_default="openai/gpt-4",
        )
        assert _resolve_summary_model(cfg, mem) == "azure/explicit-model"

    def test_falls_back_to_first_agent_model(self) -> None:
        """When summary_model is empty, prefer the team's first agent's
        gateway-routable model over the static framework default."""
        mem = SimpleNamespace(summary_model="")
        cfg = _cfg(
            agents=[
                SimpleNamespace(model="azure/gpt-5.4"),
                SimpleNamespace(model="azure/gpt-4.1-mini"),
            ],
            agent_default="anthropic/claude-sonnet-4-20250514",
            gateway_default="openai/gpt-4",
        )
        assert _resolve_summary_model(cfg, mem) == "azure/gpt-5.4"

    def test_falls_back_to_agent_default_when_no_sk_agents(self) -> None:
        mem = SimpleNamespace(summary_model="")
        cfg = _cfg(
            agents=[],
            agent_default="azure/agent-default",
            gateway_default="openai/gpt-4",
        )
        assert _resolve_summary_model(cfg, mem) == "azure/agent-default"

    def test_final_fallback_is_gateway_default(self) -> None:
        mem = SimpleNamespace(summary_model="")
        cfg = _cfg(
            agents=[],
            agent_default="",
            gateway_default="openai/gpt-4",
        )
        assert _resolve_summary_model(cfg, mem) == "openai/gpt-4"

    def test_skips_agents_without_model(self) -> None:
        mem = SimpleNamespace(summary_model="")
        cfg = _cfg(
            agents=[
                SimpleNamespace(model=""),
                SimpleNamespace(model="azure/gpt-5.4"),
            ],
            agent_default="anthropic/claude-sonnet-4-20250514",
        )
        assert _resolve_summary_model(cfg, mem) == "azure/gpt-5.4"

    def test_handles_dict_shaped_agents(self) -> None:
        """``semantic_kernel.agents`` is usually attribute-style but the
        resolver should tolerate raw dicts too."""
        mem = SimpleNamespace(summary_model="")
        cfg = SimpleNamespace(
            semantic_kernel=SimpleNamespace(
                agents=[{"name": "assistant", "model": "azure/gpt-5.4"}],
            ),
            agent=SimpleNamespace(model=""),
            gateway=SimpleNamespace(default_model="openai/gpt-4"),
        )
        assert _resolve_summary_model(cfg, mem) == "azure/gpt-5.4"

    def test_returns_empty_when_nothing_resolvable(self) -> None:
        mem = SimpleNamespace(summary_model="")
        cfg = SimpleNamespace(
            semantic_kernel=None,
            agent=None,
            gateway=SimpleNamespace(default_model=""),
        )
        assert _resolve_summary_model(cfg, mem) == ""
