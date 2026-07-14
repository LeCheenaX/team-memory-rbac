from __future__ import annotations

import json
import os
import sys
from time import perf_counter
from datetime import datetime, timezone
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


def _hook_log_file() -> str:
    explicit = os.environ.get("TEAM_MEMORY_HERMES_HOOK_LOG")
    if explicit:
        return explicit
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return os.path.join(hermes_home, "team-memory-hooks.jsonl")
    return os.path.join(os.path.expanduser("~"), ".team-memory", "hermes-hooks.jsonl")


def _load_runtime_config() -> dict[str, Any]:
    config_path = os.environ.get("TEAM_MEMORY_CONFIG_FILE")
    if not config_path:
        return {}
    try:
        with open(config_path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _dev_tool_call_log_config() -> dict[str, Any]:
    config = _load_runtime_config()
    dev = config.get("dev")
    if isinstance(dev, dict):
        tool_call_log = dev.get("hermesToolCallLog")
        if isinstance(tool_call_log, dict):
            return tool_call_log
    return {}


def _dev_tool_call_log_enabled() -> bool:
    explicit = os.environ.get("TEAM_MEMORY_HERMES_TOOL_CALL_LOG")
    if explicit is not None:
        return explicit.strip().lower() not in {"0", "false", "no", "off"}
    configured = _dev_tool_call_log_config().get("enabled")
    if isinstance(configured, bool):
        return configured
    config = _load_runtime_config()
    return str(config.get("runtimeMode", "Dev")).lower() == "dev"


def _tool_call_log_file() -> str:
    explicit = os.environ.get("TEAM_MEMORY_HERMES_TOOL_CALL_LOG_FILE")
    if explicit:
        return explicit
    configured = _dev_tool_call_log_config().get("file")
    if isinstance(configured, str) and configured:
        return configured
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return os.path.join(hermes_home, "team-memory-tool-calls.jsonl")
    return os.path.join(os.path.expanduser("~"), ".team-memory", "hermes-tool-calls.jsonl")


def _log_event(event: str, **payload: Any) -> None:
    try:
        path = _hook_log_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": event,
            **payload,
        }
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except Exception:
        return


def _log_tool_call(
    tool_name: str,
    args: dict[str, Any],
    *,
    session_id: str,
    started_at: float,
    result: Any = None,
    error: BaseException | None = None,
) -> None:
    if not _dev_tool_call_log_enabled():
        return
    try:
        path = _tool_call_log_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        entry: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": "hermes_tool_call",
            "toolName": tool_name,
            "sessionId": session_id,
            "input": args,
            "durationMs": round((perf_counter() - started_at) * 1000, 3),
        }
        if error is None:
            entry["status"] = "ok"
            entry["output"] = result
        else:
            entry["status"] = "failed"
            entry["error"] = repr(error)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except Exception:
        return


def _read_hook_log(limit: int = 50) -> list[dict[str, Any]]:
    try:
        with open(_hook_log_file(), encoding="utf-8") as handle:
            lines = handle.readlines()
    except FileNotFoundError:
        return []
    entries: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            entries.append(payload)
    return entries


def _read_tool_call_log(limit: int = 50) -> list[dict[str, Any]]:
    try:
        with open(_tool_call_log_file(), encoding="utf-8") as handle:
            lines = handle.readlines()
    except FileNotFoundError:
        return []
    entries: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            entries.append(payload)
    return entries


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
            _log_event("is_available", status="unavailable", reason="missing_session_token")
            return False
        try:
            _provider_for_token(token).validate_session()
        except Exception as exc:
            _log_event("is_available", status="unavailable", error=repr(exc))
            return False
        _log_event("is_available", status="available")
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
        _log_event("initialize", status="ok", sessionId=session_id)

    def system_prompt_block(self) -> str:
        mode = os.environ.get("TEAM_MEMORY_MODE", "http").strip().lower()
        return (
            "# Team Memory\n"
            f"Active Hermes external memory provider in {mode} mode. "
            "Use Team Memory recall before answering. For ordinary semantic writes, extract entity summaries, atomic branch facts, and explicit relations into operations[] before calling team_memory_capture. "
            "Automatic hooks capture raw conversation history as L1 Resource/CAS evidence first. "
            "Do not pass identity fields, generated ids, raw transcript-as-memory, Agent-authored ResourceChunk, outcome-as-semantic-content, or top-level payload.conflict."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not query:
            _log_event("prefetch", status="skipped", reason="empty_query")
            return ""
        resolved_session_id = session_id or getattr(self, "_session_id", "hermes")
        try:
            result = self._provider.recall_context(
                query,
                session_id=resolved_session_id,
            )
        except Exception as exc:
            _log_event("prefetch", status="failed", sessionId=resolved_session_id, error=repr(exc))
            raise
        _log_event(
            "prefetch",
            status="ok",
            sessionId=resolved_session_id,
            memoryIds=result.get("memoryIds", []),
        )
        return str(result.get("content", ""))

    def queue_prefetch(self, query: str, *, session_id: str = "", **kwargs: Any) -> str:
        _log_event(
            "queue_prefetch",
            status="delegated",
            sessionId=session_id or getattr(self, "_session_id", "hermes"),
        )
        return self.prefetch(query, session_id=session_id)

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: list[dict[str, Any]] | None = None,
    ) -> None:
        resolved_session_id = session_id or getattr(self, "_session_id", "hermes")
        self._capture_messages(
            messages
            or [
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": assistant_content},
            ],
            session_id=resolved_session_id,
            outcome="success",
            event="sync_turn",
        )

    def on_session_end(
        self,
        messages: list[dict[str, Any]],
        *,
        session_id: str = "",
        outcome: str = "success",
        **kwargs: Any,
    ) -> None:
        self._capture_messages(
            messages,
            session_id=session_id,
            outcome=outcome,
            error_summary=kwargs.get("error_summary"),
            event="on_session_end",
        )

    def on_pre_compress(
        self,
        messages: list[dict[str, Any]],
        *,
        session_id: str = "",
        **kwargs: Any,
    ) -> None:
        self._capture_messages(
            messages,
            session_id=session_id,
            outcome=str(kwargs.get("outcome") or "unknown"),
            error_summary=kwargs.get("error_summary"),
            event="on_pre_compress",
        )

    def on_memory_write(self, memory: Any, *, session_id: str = "", **kwargs: Any) -> None:
        messages = memory if isinstance(memory, list) else str(memory)
        self._capture_messages(
            messages,
            session_id=session_id,
            outcome=str(kwargs.get("outcome") or "success"),
            error_summary=kwargs.get("error_summary"),
            event="on_memory_write",
        )

    def shutdown(self, **kwargs: Any) -> None:
        _log_event(
            "shutdown",
            status="ok",
            sessionId=str(kwargs.get("session_id") or getattr(self, "_session_id", "hermes")),
        )

    def search(
        self,
        query: str,
        user_id: str | None = None,
        limit: int | None = None,
        **metadata: Any,
    ) -> dict[str, Any]:
        session_id = str(metadata.get("session_id") or user_id or getattr(self, "_session_id", "hermes"))
        provider_metadata = {
            key: value
            for key, value in metadata.items()
            if key not in {"session_id", "user_id", "limit"}
        }
        provider_metadata["session_id"] = session_id
        try:
            result = self._provider.search(query, user_id=user_id, limit=limit, **provider_metadata)
        except Exception as exc:
            _log_event("search", status="failed", sessionId=session_id, error=repr(exc))
            raise
        _log_event("search", status="ok", sessionId=session_id)
        return result

    def add(
        self,
        messages: str | list[dict[str, Any]],
        user_id: str | None = None,
        **metadata: Any,
    ) -> dict[str, Any]:
        session_id = str(metadata.get("session_id") or user_id or getattr(self, "_session_id", "hermes"))
        provider_metadata = {
            key: value
            for key, value in metadata.items()
            if key not in {"session_id", "user_id"}
        }
        provider_metadata["session_id"] = session_id
        try:
            result = self._provider.add(messages, user_id=user_id, **provider_metadata)
        except Exception as exc:
            _log_event("add", status="failed", sessionId=session_id, error=repr(exc))
            raise
        _log_event("add", status="captured", sessionId=session_id, result=result)
        return result

    def _capture_messages(
        self,
        messages: str | list[dict[str, Any]],
        *,
        session_id: str = "",
        outcome: str = "success",
        error_summary: Any = None,
        event: str = "capture_messages",
    ) -> None:
        metadata: dict[str, Any] = {
            "session_id": session_id or getattr(self, "_session_id", "hermes"),
        }
        if isinstance(error_summary, str) and error_summary:
            metadata["error_summary"] = error_summary
        try:
            result = self._provider.add(messages, outcome=outcome, **metadata)
        except Exception as exc:
            _log_event(event, status="failed", outcome=outcome, error=repr(exc), **metadata)
            raise
        _log_event(event, status="captured", outcome=outcome, result=result, **metadata)

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
                    "List the current Team Memory root, visible MemoryEntity L3 directory summaries, "
                    "statuses, tags, and tag counts. It does not expose branch facts, branch ids, L1 chunks, or relations."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {},
                },
            },
            {
                "name": "team_memory_capture",
                "description": (
                    "Capture durable semantic memory using structured operations[]. "
                    "Few-shot: memory_entity/create plus memory_entity_branch/create for a new project; "
                    "memory_entity/refresh for summary refresh; memory_entity_branch/create for duplicate facts so branch vector dedupe can update metadata; "
                    "memory_relation/create with type relates_to for related facts; memory_entity_branch/create plus memory_relation/create with type contradicts between old/new natural-name endpoints for conflicts. "
                    "Never send raw transcript-as-memory, Agent-authored ResourceChunk, clientMutationId, branchRef, expectedHeadCommitId, top-level payload.conflict, generated ids, identity/root fields, or outcome-as-semantic-content."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "operations": {"type": "array", "items": {"type": "object"}},
                    },
                    "required": ["operations"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "team_memory_lifecycle_log",
                "description": (
                    "Show recent Team Memory Hermes provider lifecycle calls, including prefetch, sync_turn, "
                    "on_session_end, on_pre_compress, explicit tool captures, and failures. Use this to debug whether Hermes actually invoked automatic memory hooks."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "default": 50},
                    },
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        session_id = str(kwargs.get("session_id") or getattr(self, "_session_id", "hermes"))
        started_at = perf_counter()
        result: Any = None
        if tool_name == "team_memory_search":
            try:
                result = self._provider.search(
                    str(args.get("query", "")),
                    session_id=session_id,
                    limit=args.get("limit"),
                    layer=args.get("layer"),
                    names=args.get("names"),
                    tagsAny=args.get("tagsAny"),
                )
            except Exception as exc:
                _log_tool_call(tool_name, args, session_id=session_id, started_at=started_at, error=exc)
                raise
            _log_tool_call(tool_name, args, session_id=session_id, started_at=started_at, result=result)
            return json.dumps(result)
        if tool_name == "team_memory_catalog":
            try:
                result = self._provider.catalog()
            except Exception as exc:
                _log_tool_call(tool_name, args, session_id=session_id, started_at=started_at, error=exc)
                raise
            _log_tool_call(tool_name, args, session_id=session_id, started_at=started_at, result=result)
            return json.dumps(result)
        if tool_name == "team_memory_capture":
            if not isinstance(args.get("operations"), list):
                raise ValueError("team_memory_capture requires operations[]")
            payload: dict[str, Any] = {
                "operations": args["operations"],
            }
            try:
                result = self._provider.write_memory(payload)
            except Exception as exc:
                _log_event("team_memory_capture", status="failed", sessionId=session_id, error=repr(exc))
                _log_tool_call(tool_name, args, session_id=session_id, started_at=started_at, error=exc)
                raise
            _log_event("team_memory_capture", status="captured", sessionId=session_id, result=result)
            _log_tool_call(tool_name, args, session_id=session_id, started_at=started_at, result=result)
            return json.dumps(result)
        if tool_name == "team_memory_lifecycle_log":
            limit = args.get("limit")
            result = {
                "hookLogFile": _hook_log_file(),
                "toolCallLogFile": _tool_call_log_file(),
                "toolCallLogEnabled": _dev_tool_call_log_enabled(),
                "entries": _read_hook_log(limit if isinstance(limit, int) else 50),
                "toolCallEntries": _read_tool_call_log(limit if isinstance(limit, int) else 50),
            }
            _log_tool_call(tool_name, args, session_id=session_id, started_at=started_at, result=result)
            return json.dumps(result)
        return json.dumps({"error": f"unknown Team Memory tool: {tool_name}"})


def register(ctx: Any) -> None:
    ctx.register_memory_provider(TeamMemoryHermesProvider())
