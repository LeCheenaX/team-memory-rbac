from __future__ import annotations

import json
import os
import sys
from typing import Any

from agent.memory_provider import MemoryProvider

_REPO_ROOT = os.environ.get("TEAM_MEMORY_REPO_ROOT", "/opt/team-memory-rbac")
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from src.adapters.hermes.http_client import HermesTeamMemoryProvider


def _session_file() -> str:
    explicit = os.environ.get("TEAM_MEMORY_SESSION_FILE")
    if explicit:
        return explicit
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return os.path.join(hermes_home, "team-memory-session.json")
    return os.path.join(os.path.expanduser("~"), ".team-memory", "session.json")


def _session_token() -> str:
    token = os.environ.get("TEAM_MEMORY_TOKEN", "")
    if token:
        return token
    try:
        with open(_session_file(), encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return ""
    except json.JSONDecodeError:
        return ""
    value = payload.get("sessionToken")
    return value if isinstance(value, str) else ""


class TeamMemoryHermesProvider(MemoryProvider):
    @property
    def name(self) -> str:
        return "team_memory"

    def is_available(self) -> bool:
        return bool(_session_token())

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        token = _session_token()
        mode = os.environ.get("TEAM_MEMORY_MODE", "http").strip().lower()
        if mode == "local":
            self._provider = HermesTeamMemoryProvider.from_local(
                token,
                repo_root=os.environ.get("TEAM_MEMORY_REPO_ROOT", "/opt/team-memory-rbac"),
            )
        else:
            self._provider = HermesTeamMemoryProvider.from_http(
                os.environ.get("TEAM_MEMORY_URL", "http://service:3000"),
                token,
            )
        self._session_id = session_id

    def system_prompt_block(self) -> str:
        mode = os.environ.get("TEAM_MEMORY_MODE", "http").strip().lower()
        return (
            "# Team Memory\n"
            f"Active Hermes external memory provider in {mode} mode. "
            "Use Team Memory recall before answering and capture durable memories after useful turns."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not query:
            return ""
        result = self._provider.recall_context(
            query,
            session_id=session_id or getattr(self, "_session_id", "hermes"),
        )
        return str(result.get("content", ""))

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: list[dict[str, Any]] | None = None,
    ) -> None:
        self._provider.add(
            [
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": assistant_content},
            ],
            session_id=session_id or getattr(self, "_session_id", "hermes"),
        )

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "team_memory_search",
                "description": "Search Team Memory for durable context relevant to the current task.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer"},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "team_memory_capture",
                "description": "Capture a durable Team Memory note from the current conversation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string"},
                        "outcome": {"type": "string", "default": "success"},
                    },
                    "required": ["content"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        session_id = str(kwargs.get("session_id") or getattr(self, "_session_id", "hermes"))
        if tool_name == "team_memory_search":
            result = self._provider.search(
                str(args.get("query", "")),
                session_id=session_id,
                limit=args.get("limit"),
            )
            return json.dumps(result)
        if tool_name == "team_memory_capture":
            result = self._provider.add(
                str(args.get("content", "")),
                session_id=session_id,
                outcome=str(args.get("outcome") or "success"),
            )
            return json.dumps(result)
        return json.dumps({"error": f"unknown Team Memory tool: {tool_name}"})


def register(ctx: Any) -> None:
    ctx.register_memory_provider(TeamMemoryHermesProvider())
