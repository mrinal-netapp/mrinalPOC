"""Member execution abstraction for team orchestration."""

from typing import Any


class MemberExecutor:
    async def execute(self, member_ref: dict[str, Any], payload: dict[str, Any]) -> Any:
        raise NotImplementedError


class LocalExecutor(MemberExecutor):
    async def execute(self, member_ref: dict[str, Any], payload: dict[str, Any]) -> Any:
        fn = member_ref.get("callable")
        if fn is None:
            raise ValueError("LocalExecutor requires member_ref.callable")
        return await fn(payload)


class A2AExecutor(MemberExecutor):
    async def execute(self, member_ref: dict[str, Any], payload: dict[str, Any]) -> Any:
        # Outbound A2A exposure remains deferred. This keeps the transport
        # boundary explicit while avoiding protocol coupling in team logic.
        raise NotImplementedError("A2A member transport is not enabled in this release")
