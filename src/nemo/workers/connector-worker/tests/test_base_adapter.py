"""Unit tests for adapters.base helpers."""

from __future__ import annotations

from adapters.base import ExplorerError, ExplorerNode, ExplorerResponse


class TestExplorerResponse:
    def test_to_dict_includes_next_token_and_error(self):
        resp = ExplorerResponse(
            nodes=[
                ExplorerNode(
                    id="n1",
                    label="Node",
                    type="file",
                    kind="File",
                    children_hint="leaf",
                    resource={"k": "v"},
                    metadata={"m": 1},
                    actions=["open"],
                )
            ],
            next_token="tok-2",
            error=ExplorerError("ERR", "something failed"),
        )
        d = resp.to_dict()
        assert d["nextToken"] == "tok-2"
        assert d["error"]["code"] == "ERR"
        node = d["nodes"][0]
        assert node["kind"] == "File"
        assert node["childrenHint"] == "leaf"
        assert node["resource"] == {"k": "v"}
        assert node["metadata"] == {"m": 1}
        assert node["actions"] == ["open"]

    def test_to_dict_omits_optional_fields(self):
        resp = ExplorerResponse(
            nodes=[ExplorerNode(id="n1", label="L", type="folder")],
        )
        d = resp.to_dict()
        assert "nextToken" not in d
        assert "error" not in d
        assert d["nodes"][0] == {"id": "n1", "label": "L", "type": "folder"}
