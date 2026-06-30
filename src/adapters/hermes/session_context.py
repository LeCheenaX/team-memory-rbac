from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class PrincipalContext:
    session_id: str
    user_id: str
    agent_id: str
    root_entity_id: str
    task_scope: dict[str, Any]
    delegation_id: str | None = None
    parent_agent_id: str | None = None


def map_principal_context(payload: dict[str, Any]) -> PrincipalContext:
    """Map the generated transport contract without applying RBAC rules."""
    return PrincipalContext(
        session_id=payload["sessionId"],
        user_id=payload["userId"],
        agent_id=payload["agentId"],
        root_entity_id=payload["rootEntityId"],
        task_scope=payload["taskScope"],
        delegation_id=payload.get("delegationId"),
        parent_agent_id=payload.get("parentAgentId"),
    )


class HermesMemoryAdapter:
    """Thin Hermes lifecycle/protocol bridge to the TypeScript core."""

    def __init__(
        self,
        resolve_principal: Callable[[str], dict[str, Any]],
        list_tools: Callable[[str], list[dict[str, Any]]],
        invoke_tool: Callable[
            [str, str, dict[str, Any]], dict[str, Any]
        ],
    ) -> None:
        self._resolve_principal = resolve_principal
        self._list_tools = list_tools
        self._invoke_tool = invoke_tool

    def resolve_principal(self, session_token: str) -> PrincipalContext:
        return map_principal_context(
            self._resolve_principal(session_token)
        )

    def list_tools(self, session_token: str) -> list[dict[str, Any]]:
        return self._list_tools(session_token)

    def invoke_tool(
        self,
        session_token: str,
        tool_name: str,
        input_payload: dict[str, Any],
    ) -> dict[str, Any]:
        return self._invoke_tool(
            session_token, tool_name, input_payload
        )
