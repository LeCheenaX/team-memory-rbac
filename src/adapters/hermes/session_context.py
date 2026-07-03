from dataclasses import dataclass
from typing import Any, Callable

SUPPORTED_MEMORY_MODES = [
    "parallel_native_team_memory",
    "team_memory_replaces_native",
]


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

    @property
    def supported_memory_modes(self) -> list[str]:
        return list(SUPPORTED_MEMORY_MODES)

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

    def create_memory_integration_plan(
        self,
        session_token: str,
        mode: str,
    ) -> dict[str, Any]:
        if mode not in SUPPORTED_MEMORY_MODES:
            raise ValueError(f"unsupported memory mode: {mode}")
        principal_payload = self._resolve_principal(session_token)
        tools = self.list_tools(session_token)
        tool_names = [tool["name"] for tool in tools]
        read_tools = [
            name for name in tool_names
            if name in {
                "memory.read",
                "memory.search",
                "memory.readResource",
                "memory.ingestResource",
                "memory.syncPull",
            }
        ]
        write_tools = [
            name for name in tool_names
            if name in {
                "memory.write",
                "memory.importResource",
                "memory.ingestResource",
            }
        ]
        return {
            "host": "hermes",
            "displayName": "Hermes",
            "mode": mode,
            "connector": "python_adapter",
            "nativeMemory": {
                "disposition": (
                    "preserved"
                    if mode == "parallel_native_team_memory"
                    else "replaced_by_team_memory"
                ),
                "controls": [
                    (
                        "Keep Hermes official memory providers such as mem0 "
                        "separate from the Team Memory provider namespace"
                    )
                    if mode == "parallel_native_team_memory"
                    else (
                        "Configure Team Memory as the authoritative Hermes "
                        "long-term memory provider"
                    )
                ],
            },
            "hostConfiguration": {
                "actions": [
                    (
                        "Register the Team Memory Hermes provider at the "
                        "same memory-plugin seam as mem0-style providers"
                    ),
                    (
                        "Keep authorization, memory writes, retrieval, "
                        "and history in the TypeScript core"
                    ),
                ],
                "settings": {},
            },
            "identitySource": "trusted_session",
            "principal": principal_payload,
            "teamMemory": {
                "canRead": len(read_tools) > 0,
                "canWrite": "memory.write" in write_tools,
                "readTools": read_tools,
                "writeTools": write_tools,
                "visibleTools": tools,
            },
        }
