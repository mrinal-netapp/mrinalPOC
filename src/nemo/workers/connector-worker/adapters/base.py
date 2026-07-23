"""Base adapter interface for all provider adapters."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ExplorerNode:
    id: str
    label: str
    type: str
    kind: Optional[str] = None
    children_hint: Optional[str] = None
    resource: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None
    actions: Optional[List[str]] = None


@dataclass
class ExplorerError:
    code: str
    message: str


@dataclass
class ExplorerResponse:
    nodes: List[ExplorerNode] = field(default_factory=list)
    next_token: Optional[str] = None
    error: Optional[ExplorerError] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "nodes": [_node_to_dict(n) for n in self.nodes],
        }
        if self.next_token:
            result["nextToken"] = self.next_token
        if self.error:
            result["error"] = {"code": self.error.code, "message": self.error.message}
        return result


def _node_to_dict(node: ExplorerNode) -> Dict[str, Any]:
    d: Dict[str, Any] = {"id": node.id, "label": node.label, "type": node.type}
    if node.kind is not None:
        d["kind"] = node.kind
    if node.children_hint is not None:
        d["childrenHint"] = node.children_hint
    if node.resource is not None:
        d["resource"] = node.resource
    if node.metadata is not None:
        d["metadata"] = node.metadata
    if node.actions is not None:
        d["actions"] = node.actions
    return d


class ProviderAdapter(ABC):
    """All provider adapters must implement execute(). Optionally implement resolve()."""

    @abstractmethod
    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        ...

    def resolve(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        resource_selector: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Return effective config by merging connector config with resource selector.
        Default implementation merges resource_selector into connector_config.
        """
        effective = dict(connector_config)
        effective.update(resource_selector)
        return effective
