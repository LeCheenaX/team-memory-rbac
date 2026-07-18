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


_NON_EMPTY_STRING_SCHEMA: dict[str, Any] = {"type": "string", "minLength": 1}
_STRING_ARRAY_SCHEMA: dict[str, Any] = {
    "type": "array",
    "items": {"type": "string"},
    "uniqueItems": True,
}
_RELATION_ENDPOINT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["target", "name"],
    "properties": {
        "target": {
            "enum": ["memory_entity", "memory_entity_branch", "resource", "resource_chunk"],
        },
        "name": _NON_EMPTY_STRING_SCHEMA,
        "parent": _NON_EMPTY_STRING_SCHEMA,
    },
}
_CAPTURE_OPERATION_PROPERTIES_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "name": _NON_EMPTY_STRING_SCHEMA,
        "desc": {
            "type": "string",
            "description": "For a memory_entity_branch, exactly one independently useful proposition; split compound claims into separate branches. For a memory_entity, only a high-level subject summary.",
        },
        "tags": _STRING_ARRAY_SCHEMA,
        "status": {"type": "string"},
        "extra": {"type": "object"},
    },
}
_CAPTURE_OPERATION_SCHEMA: dict[str, Any] = {
    "oneOf": [
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["target", "op", "properties"],
            "properties": {
                "target": {
                    "const": "memory_entity",
                    "description": "A stable subject/container only; never create one memory_entity per concrete claim.",
                },
                "op": {"enum": ["create", "update", "refresh"]},
                "properties": _CAPTURE_OPERATION_PROPERTIES_SCHEMA,
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["target", "op", "subject", "properties"],
            "properties": {
                "target": {
                    "const": "memory_entity_branch",
                    "description": "One concrete atomic claim about the parent subject; create multiple branches for multiple independently changeable claims.",
                },
                "op": {"enum": ["create", "update_metadata"]},
                "subject": {
                    "oneOf": [
                        _NON_EMPTY_STRING_SCHEMA,
                        _RELATION_ENDPOINT_SCHEMA,
                    ],
                },
                "properties": _CAPTURE_OPERATION_PROPERTIES_SCHEMA,
            },
        },
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["target", "op", "type", "subject", "object"],
            "properties": {
                "target": {"const": "memory_relation"},
                "op": {"enum": ["create", "replace"]},
                "type": {
                    "enum": ["has", "depends_on", "relates_to", "refers_to", "contradicts", "supersedes", "next_is"],
                },
                "subject": _RELATION_ENDPOINT_SCHEMA,
                "object": _RELATION_ENDPOINT_SCHEMA,
            },
        },
    ],
}


def _tool_schema(name: str, description: str, parameters: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": parameters,
        "input_schema": parameters,
        "inputSchema": parameters,
    }


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
"Use Team Memory recall before answering. Every team_memory_search call must select an explicit layer: L3 for entity identity and summaries, L2 for atomic facts and relations, or L1 for source evidence. Use L2 before concrete factual answers, corrections, or conflict-aware writes. For ordinary semantic writes, extract entity summaries, atomic branch facts, and explicit relations into operations[] before calling team_memory_capture. "
            "A MemoryEntity is only one stable subject/container with a high-level summary, never a concrete fact or one entity per claim. Store each concrete claim as a separate MemoryEntityBranch under that subject. "
            "A branch must contain exactly one independently useful proposition; split conjunctions, lists, multiple sentences, workflow steps, constraints, responsibilities, preferences, and independently changeable details into separate branches. Never leave concrete facts only in the entity summary. "
            "Classify each semantic write as repeated, additive, or correction before capture. "
            "For an additive fact, write one independently retrievable branch containing only the newly stated semantic delta; recalled memory is read-only context and must not be copied into the new description. "
            "For a repeated fact, reuse the same atomic fact name so dedupe can refresh metadata. "
            "For a correction, recall the old fact, create a new atomic branch, and relate the new fact to the old fact with supersedes or contradicts as appropriate. "
            "Each operation must use target plus op fields, for example target=memory_entity and op=create; never send an action field. "
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
            user_prompt=user_content,
            final_assistant_message=assistant_content,
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
        user_prompt: Any = None,
        final_assistant_message: Any = None,
        event: str = "capture_messages",
    ) -> None:
        metadata: dict[str, Any] = {
            "session_id": session_id or getattr(self, "_session_id", "hermes"),
        }
        if isinstance(error_summary, str) and error_summary:
            metadata["error_summary"] = error_summary
        if isinstance(user_prompt, str) and user_prompt:
            metadata["user_prompt"] = user_prompt
        if isinstance(final_assistant_message, str) and final_assistant_message:
            metadata["final_assistant_message"] = final_assistant_message
        try:
            result = self._provider.add(messages, outcome=outcome, **metadata)
        except Exception as exc:
            _log_event(event, status="failed", outcome=outcome, error=repr(exc), **metadata)
            raise
        _log_event(event, status="captured", outcome=outcome, result=result, **metadata)

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [
            _tool_schema(
                "team_memory_search",
                (
                    "Search Team Memory for durable context relevant to the current task. "
                    "Always select an explicit layer: L3 for entity identity and summaries, L2 for atomic facts and relations, or L1 for source evidence. "
                    "Use L2 before concrete factual answers, corrections, or conflict-aware writes. Use the natural-language query, optional limit, "
                    "and stable entity/tag filters. Copy every tagsAny value exactly from team_memory_catalog; if no suitable visible tag exists, "
                    "use names or query instead of inventing one. Variable metadata appears under extra when returned."
                ),
                {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer"},
                        "layer": {"type": "string", "enum": ["L1", "L2", "L3"], "description": "Required explicit recall layer: L3 entity summaries, L2 atomic facts and relations, L1 source evidence. Use L2 for factual answers, corrections, and conflict-aware writes."},
                        "names": {"type": "array", "items": {"type": "string"}},
                        "tagsAny": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Exact visible tag strings copied from team_memory_catalog; these are filters, not inferred keywords.",
                        },
                    },
                    "required": ["query", "layer"],
                },
            ),
            _tool_schema(
                "team_memory_catalog",
                (
                    "List the current Team Memory root, visible MemoryEntity L3 directory summaries, "
                    "statuses, and plain tag strings sorted by descending visible entity count with deterministic ties. "
                    "It does not expose tag counts, tag-to-name mappings, branch facts, branch ids, L1 chunks, or relations."
                ),
                {
                    "type": "object",
                    "properties": {},
                },
            ),
            _tool_schema(
                "team_memory_capture",
                (
                    "Capture durable semantic memory using structured operations[]. "
                    "A MemoryEntity is only a stable subject/container with a high-level summary, never a concrete fact or one entity per claim. Create or reuse one memory_entity per stable subject, then store every concrete claim as a separate memory_entity_branch under it. "
                    "Each branch desc must contain exactly one independently useful proposition. Split conjunctions, lists, multiple sentences, workflow steps, constraints, responsibilities, preferences, and independently changeable details into separate branch operations. Never leave concrete claims only in memory_entity.desc. "
                    "Each operation item must use target and op fields, not action. Correct entity JSON is {\"target\":\"memory_entity\",\"op\":\"create\",\"properties\":{\"name\":\"Riverfront\",\"desc\":\"...\"}}. "
                    "Correct branch JSON is {\"target\":\"memory_entity_branch\",\"op\":\"create\",\"subject\":\"Riverfront\",\"properties\":{\"name\":\"Riverfront naming preference\",\"desc\":\"...\"}}. "
                    "Correct relation JSON is {\"target\":\"memory_relation\",\"op\":\"create\",\"type\":\"relates_to\",\"subject\":{\"target\":\"memory_entity\",\"name\":\"Riverfront\"},\"object\":{\"target\":\"memory_entity\",\"name\":\"OpenClaw\"}}. "
                    "Use target=memory_entity with op=refresh for summary refresh; target=memory_entity_branch with op=create for duplicate facts so branch vector dedupe can update metadata; "
                    "For additive facts, capture only the newly stated semantic delta in a new branch with a predicate-specific name; do not reuse broad topic names such as Riverfront weekly report structure. "
                    "Never merge or append recalled descriptions into an additive fact, and never resubmit old facts merely to add the new detail. Recalled content is read-only write context. "
                    "Use the same branch name only for a true repeat of the same independently retrievable fact; use a distinct branch name for a new preference, constraint, responsibility, or workflow step. "
                    "Negative few-shot: for 'Riverfront uses weekly reports, Mina owns them, and they are due Friday', do not create three memory_entity items and do not create one compound branch containing all three claims. "
                    "Positive few-shot: create or reuse memory_entity 'Riverfront', then create three branches under subject 'Riverfront': 'Riverfront report cadence' desc 'Riverfront uses weekly status reports.'; 'Riverfront report owner' desc 'Mina owns Riverfront weekly reports.'; and 'Riverfront report due day' desc 'Riverfront weekly reports are due every Friday.'. "
                    "target=memory_relation with op=create and type=relates_to for related facts; target=memory_entity_branch with op=create plus target=memory_relation with op=create and type=contradicts between old/new natural-name endpoints for conflicts. "
                    "Never use action/title/content/entity_key/source/target as the old action-style operation shape. "
                    "Never send raw transcript-as-memory, Agent-authored ResourceChunk, clientMutationId, branchRef, expectedHeadCommitId, top-level payload.conflict, generated ids, identity/root fields, or outcome-as-semantic-content."
                ),
                {
                    "type": "object",
                    "properties": {
                        "operations": {"type": "array", "minItems": 1, "items": _CAPTURE_OPERATION_SCHEMA},
                    },
                    "required": ["operations"],
                    "additionalProperties": False,
                },
            ),
            _tool_schema(
                "team_memory_lifecycle_log",
                (
                    "Show recent Team Memory Hermes provider lifecycle calls, including prefetch, sync_turn, "
                    "on_session_end, on_pre_compress, explicit tool captures, and failures. Use this to debug whether Hermes actually invoked automatic memory hooks."
                ),
                {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "default": 50},
                    },
                },
            ),
        ]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        session_id = str(kwargs.get("session_id") or getattr(self, "_session_id", "hermes"))
        started_at = perf_counter()
        result: Any = None
        if tool_name == "team_memory_search":
            layer = args.get("layer")
            if layer not in {"L1", "L2", "L3"}:
                raise ValueError("team_memory_search requires layer L1, L2, or L3")
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
            for index, operation in enumerate(args["operations"]):
                if isinstance(operation, dict) and "action" in operation:
                    raise ValueError(
                        "team_memory_capture operations use target/op fields; "
                        f"operations[{index}] must not provide action"
                    )
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
