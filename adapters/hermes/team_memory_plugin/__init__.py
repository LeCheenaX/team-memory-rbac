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
    value = payload.get("agentSessionToken") or payload.get("sessionToken")
    return value if isinstance(value, str) else ""


def _provider_for_token(token: str) -> HermesTeamMemoryProvider:
    mode = os.environ.get("TEAM_MEMORY_MODE", "http").strip().lower()
    if mode == "local":
        repo_root = os.environ.get("TEAM_MEMORY_REPO_ROOT", "/opt/team-memory-rbac")
        config_path = os.environ.get(
            "TEAM_MEMORY_CONFIG_FILE",
            "/workspace/config/team-memory.hermes-local.json",
        )
        return HermesTeamMemoryProvider.from_local(
            token,
            repo_root=repo_root,
            config_path=config_path,
        )
    return HermesTeamMemoryProvider.from_http(
        os.environ.get("TEAM_MEMORY_URL", "http://service:3000"),
        token,
    )


class TeamMemoryHermesProvider(MemoryProvider):
    @property
    def name(self) -> str:
        return "team_memory"

    def is_available(self) -> bool:
        token = _session_token()
        if not token:
            return False
        try:
            _provider_for_token(token).validate_session()
        except Exception:
            return False
        return True

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        token = _session_token()
        if not token:
            raise RuntimeError(
                "Team Memory is not logged in for this Hermes container. Run Team Memory login before enabling the memory provider."
            )
        self._provider = _provider_for_token(token)
        self._provider.validate_session()
        self._session_id = session_id

    def system_prompt_block(self) -> str:
        mode = os.environ.get("TEAM_MEMORY_MODE", "http").strip().lower()
        return (
            "# Team Memory\n"
            f"Active Hermes external memory provider in {mode} mode. "
            "Use Team Memory recall before answering and capture durable conversation memories after useful turns. "
            "Do not pass identity fields, history toggles, conflict claims, or relationship arguments; "
            "Team Memory derives merges, conflicts, relations, and extra metadata internally."
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
                "description": (
                    "Search Team Memory for durable context relevant to the current task. "
                    "Use the natural-language query, optional limit, and stable entity/tag filters; the query determines whether history, "
                    "facts, resources, or relations are recalled. Variable metadata appears under extra when returned."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer"},
                        "layer": {"type": "string", "enum": ["L1", "L2", "L3"]},
                        "names": {"type": "array", "items": {"type": "string"}},
                        "tagsAny": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "team_memory_catalog",
                "description": (
                    "List the current Team Memory root, visible MemoryEntity identities, their current branch summaries, "
                    "and available tags. Use this before follow-up searches that should narrow by entity or tags."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {},
                },
            },
            {
                "name": "team_memory_capture",
                "description": (
                    "Capture durable conversation memory with stable arguments only. "
                    "Pass content and optional outcome; Team Memory decides whether to create, merge, conflict, "
                    "supersede, or relate memory branches, and any variable metadata is returned under extra. "
                    "For raw files or documents, import the resource into Team Memory/CAS and trigger resource ingestion instead of using this tool."
                ),
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
                layer=args.get("layer"),
                names=args.get("names"),
                tagsAny=args.get("tagsAny"),
            )
            return json.dumps(result)
        if tool_name == "team_memory_catalog":
            return json.dumps(self._provider.catalog())
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
