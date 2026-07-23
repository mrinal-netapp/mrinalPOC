"""Tests for the deep_merge function in config_loader.

Covers all merge rules:
- Flat dict override wins
- Nested dicts merge recursively
- Lists replaced not appended
- None values in override are skipped
- New keys from override are added
- Deep copy (no mutation of inputs)
- Empty override returns base copy
- Three-tier chain produces correct priority
"""

from __future__ import annotations

from copy import deepcopy

from agent_service_maf.config.config_loader import deep_merge


class TestDeepMerge_FlatDicts:
    """Tests for flat (non-nested) dict merging."""

    def test_flat_dicts_override_wins(self) -> None:
        """Override values replace base values for the same key."""
        base = {"a": 1, "b": 2}
        override = {"b": 3, "c": 4}
        result = deep_merge(base, override)
        assert result["b"] == 3, "Override value should win over base value for key 'b'"
        assert result["a"] == 1, "Base key 'a' not in override should be preserved"
        assert result["c"] == 4, "New key 'c' from override should be added to result"

    def test_flat_dicts_base_preserved_for_unoverridden_keys(self) -> None:
        """Keys present in base but not override are preserved in result."""
        base = {"x": 100, "y": 200, "z": 300}
        override = {"x": 999}
        result = deep_merge(base, override)
        assert result["y"] == 200, "Key 'y' from base should be preserved unchanged"
        assert result["z"] == 300, "Key 'z' from base should be preserved unchanged"
        assert result["x"] == 999, "Key 'x' should use override value"

    def test_empty_override_returns_base_copy(self) -> None:
        """An empty override dict should return a copy of base."""
        base = {"a": 1, "b": [1, 2], "c": {"nested": True}}
        result = deep_merge(base, {})
        assert result == base, "Empty override should produce a result equal to base"

    def test_empty_base_returns_override_copy(self) -> None:
        """An empty base dict should return a copy of the override."""
        override = {"x": 42, "y": "hello"}
        result = deep_merge({}, override)
        assert result == override, "Empty base should produce a result equal to override"

    def test_both_empty_returns_empty(self) -> None:
        """Merging two empty dicts should return an empty dict."""
        result = deep_merge({}, {})
        assert result == {}, "Merging two empty dicts should produce an empty dict"


class TestDeepMerge_NestedDicts:
    """Tests for recursive nested dict merging."""

    def test_nested_dicts_merge_recursively(self) -> None:
        """Nested dicts should be merged recursively, not replaced."""
        base = {"a": {"x": 1, "y": 2}, "b": 3}
        override = {"a": {"y": 99, "z": 100}}
        result = deep_merge(base, override)
        assert result["a"]["x"] == 1, "Key 'x' in nested dict should be preserved from base"
        assert result["a"]["y"] == 99, "Key 'y' in nested dict should be overridden"
        assert result["a"]["z"] == 100, "Key 'z' in nested dict should be added from override"
        assert result["b"] == 3, "Top-level key 'b' not in override should be preserved"

    def test_deeply_nested_dicts_merge_recursively(self) -> None:
        """Three-levels of nesting should all merge recursively."""
        base = {"a": {"b": {"c": {"d": 1, "e": 2}}}}
        override = {"a": {"b": {"c": {"d": 99}}}}
        result = deep_merge(base, override)
        assert result["a"]["b"]["c"]["d"] == 99, "Deep override value should win"
        assert result["a"]["b"]["c"]["e"] == 2, "Deep base value should be preserved"

    def test_nested_dict_key_not_in_base_is_added(self) -> None:
        """New nested keys from override should be added to result."""
        base = {"a": {"x": 1}}
        override = {"b": {"y": 2}}
        result = deep_merge(base, override)
        assert result["a"]["x"] == 1, "Original nested key should be preserved"
        assert result["b"]["y"] == 2, "New nested key from override should be added"

    def test_nested_dict_overrides_scalar_in_base(self) -> None:
        """A dict value in override should replace a scalar in base at the same key."""
        base = {"key": 42}
        override = {"key": {"nested": True}}
        result = deep_merge(base, override)
        assert result["key"] == {"nested": True}, "Dict in override should replace scalar in base"

    def test_scalar_overrides_nested_dict_in_base(self) -> None:
        """A scalar value in override should replace a dict in base at the same key."""
        base = {"key": {"nested": True}}
        override = {"key": "scalar"}
        result = deep_merge(base, override)
        assert result["key"] == "scalar", "Scalar in override should replace nested dict in base"


class TestDeepMerge_ListReplacement:
    """Tests for list replacement behavior."""

    def test_lists_replaced_not_appended(self) -> None:
        """Lists in override replace lists in base entirely."""
        base = {"tags": ["a", "b", "c"]}
        override = {"tags": ["x"]}
        result = deep_merge(base, override)
        assert result["tags"] == ["x"], (
            "Override list should fully replace base list, not append to it"
        )

    def test_longer_list_in_override_replaces_base(self) -> None:
        """Override list of any length replaces base list."""
        base = {"items": [1]}
        override = {"items": [10, 20, 30, 40, 50]}
        result = deep_merge(base, override)
        assert result["items"] == [10, 20, 30, 40, 50], (
            "Longer override list should fully replace shorter base list"
        )

    def test_empty_list_in_override_replaces_base_list(self) -> None:
        """An empty list in override replaces the base list."""
        base = {"rules": ["rule1", "rule2"]}
        override = {"rules": []}
        result = deep_merge(base, override)
        assert result["rules"] == [], "Empty list in override should replace base list"

    def test_list_of_dicts_replaced_not_merged(self) -> None:
        """A list of dicts in override replaces the base list; individual dicts are not merged."""
        base = {"guardrails": [{"name": "g1", "enabled": True}]}
        override = {"guardrails": [{"name": "g2"}]}
        result = deep_merge(base, override)
        assert len(result["guardrails"]) == 1, (
            "Override list of dicts should replace base list entirely"
        )
        assert result["guardrails"][0]["name"] == "g2", (
            "Override list element should be present in result"
        )

    def test_nested_list_in_nested_dict_replaced(self) -> None:
        """Lists nested inside dicts should still be replaced, not merged."""
        base = {"section": {"items": [1, 2, 3]}}
        override = {"section": {"items": [4, 5]}}
        result = deep_merge(base, override)
        assert result["section"]["items"] == [4, 5], (
            "Nested override list should replace nested base list"
        )


class TestDeepMerge_NoneHandling:
    """Tests for None value handling in overrides."""

    def test_none_values_in_override_skipped(self) -> None:
        """None values in override should not overwrite base values."""
        base = {"a": 1, "b": 2}
        override = {"a": None, "b": 3}
        result = deep_merge(base, override)
        assert result["a"] == 1, "None override value should leave base value unchanged"
        assert result["b"] == 3, "Non-None override value should still override"

    def test_all_none_override_leaves_base_intact(self) -> None:
        """All None values in override should preserve the entire base."""
        base = {"x": 10, "y": 20, "z": 30}
        override = {"x": None, "y": None, "z": None}
        result = deep_merge(base, override)
        assert result == base, "All None override values should leave base completely intact"

    def test_none_override_for_key_not_in_base_adds_nothing(self) -> None:
        """None override for a key not in base should not add the key."""
        base = {"a": 1}
        override = {"new_key": None}
        result = deep_merge(base, override)
        assert "new_key" not in result, (
            "None override for new key should not add that key to result"
        )

    def test_false_not_treated_as_none(self) -> None:
        """False is a valid override value and should NOT be treated like None."""
        base = {"enabled": True}
        override = {"enabled": False}
        result = deep_merge(base, override)
        assert result["enabled"] is False, (
            "False should override True; False must not be treated as None"
        )

    def test_zero_not_treated_as_none(self) -> None:
        """Zero (int) is a valid override value and should NOT be treated like None."""
        base = {"count": 5}
        override = {"count": 0}
        result = deep_merge(base, override)
        assert result["count"] == 0, (
            "Zero should override base value; 0 must not be treated as None"
        )

    def test_empty_string_not_treated_as_none(self) -> None:
        """Empty string is a valid override value and should NOT be treated like None."""
        base = {"name": "default"}
        override = {"name": ""}
        result = deep_merge(base, override)
        assert result["name"] == "", (
            "Empty string should override base value; '' must not be treated as None"
        )


class TestDeepMerge_Immutability:
    """Tests ensuring deep_merge does not mutate its inputs."""

    def test_base_not_mutated(self) -> None:
        """The base dict should not be modified by deep_merge."""
        base = {"a": {"x": 1}, "b": [1, 2]}
        original_base = deepcopy(base)
        deep_merge(base, {"a": {"y": 2}, "b": [3]})
        assert base == original_base, "deep_merge must not mutate the base dict"

    def test_override_not_mutated(self) -> None:
        """The override dict should not be modified by deep_merge."""
        override = {"a": {"y": 2}, "b": [3]}
        original_override = deepcopy(override)
        deep_merge({"a": {"x": 1}, "b": [1, 2]}, override)
        assert override == original_override, "deep_merge must not mutate the override dict"

    def test_result_is_deep_copy_not_reference(self) -> None:
        """Mutating the result should not affect the inputs."""
        base = {"nested": {"value": 1}}
        result = deep_merge(base, {})
        result["nested"]["value"] = 999
        assert base["nested"]["value"] == 1, (
            "Mutating result nested dict should not affect base (must be deep copy)"
        )

    def test_result_list_is_deep_copy(self) -> None:
        """Mutating a list in the result should not affect inputs."""
        base = {"items": [1, 2, 3]}
        result = deep_merge(base, {})
        result["items"].append(99)
        assert base["items"] == [1, 2, 3], (
            "Mutating result list should not affect base (must be deep copy)"
        )


class TestDeepMerge_ThreeTierChain:
    """Tests for three-tier priority chain: defaults < env < json < request."""

    def test_three_tier_chain_correct_priority(self) -> None:
        """Later merges win: request > json > env > defaults."""
        defaults = {"a": "defaults", "b": "defaults", "c": "defaults", "d": "defaults"}
        env = {"b": "env", "c": "env", "d": "env"}
        json_cfg = {"c": "json", "d": "json"}
        request = {"d": "request"}

        # Simulate three-tier merge
        result = deep_merge(defaults, env)
        result = deep_merge(result, json_cfg)
        result = deep_merge(result, request)

        assert result["a"] == "defaults", "Unoverridden key should keep defaults value"
        assert result["b"] == "env", "Env should override defaults"
        assert result["c"] == "json", "JSON should override env and defaults"
        assert result["d"] == "request", "Request should win over all other tiers"

    def test_three_tier_nested_priority(self) -> None:
        """Three-tier priority works correctly for nested keys too."""
        defaults = {"section": {"x": 1, "y": 2, "z": 3}}
        env_cfg = {"section": {"y": 20, "z": 30}}
        json_cfg = {"section": {"z": 300}}

        result = deep_merge(defaults, env_cfg)
        result = deep_merge(result, json_cfg)

        assert result["section"]["x"] == 1, "Defaults value for 'x' should be preserved"
        assert result["section"]["y"] == 20, "Env value for 'y' should override defaults"
        assert result["section"]["z"] == 300, "JSON value for 'z' should override env"

    def test_three_tier_none_in_middle_tier_preserved(self) -> None:
        """None in an intermediate tier is skipped; lower tier value survives."""
        defaults = {"val": "from-defaults"}
        middle = {"val": None}  # None should skip
        top = {"other": "top"}

        result = deep_merge(defaults, middle)
        result = deep_merge(result, top)

        assert result["val"] == "from-defaults", (
            "None in middle tier should be skipped; defaults value should survive"
        )
        assert result["other"] == "top", "Top tier key should be present"
