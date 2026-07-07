import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable
from urllib import request
from urllib.error import HTTPError

from .session_context import HermesMemoryAdapter


class TeamMemoryHttpError(RuntimeError):
    def __init__(self, status: int, payload: dict[str, Any]) -> None:
        error = payload.get("error", {})
        self.status = status
        self.code = str(error.get("code", "http_error"))
        self.decision = error.get("decision")
        super().__init__(f"{self.code}: {error.get('message', 'Team Memory request failed')}")


class TeamMemoryHttpClient:
    """Small stdlib HTTP client for Hermes and Python hosts."""

    def __init__(
        self,
        base_url: str,
        token: str,
        transport: Callable[[str, str, dict[str, Any] | None], dict[str, Any]] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.token = token
        self._transport = transport

    def identity(self) -> dict[str, Any]:
        return self._request("GET", "identity")

    def list_tools(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "agent/tools")
        return payload["value"]

    def call_tool(self, tool_name: str, input_payload: dict[str, Any]) -> dict[str, Any]:
        if tool_name == "memory.importResource":
            return self._request("POST", "resources/import", input_payload)["value"]
        if tool_name == "memory.ingestResource":
            resource_id = self._required_string(input_payload, "resourceId")
            return self._request("POST", f"resources/{resource_id}/ingest", input_payload)["value"]
        if tool_name == "memory.readResource":
            resource_id = self._required_string(input_payload, "resourceId")
            return self._request("GET", f"resources/{resource_id}")
        if tool_name == "memory.write":
            return self._request("POST", "memory/write", input_payload)["value"]
        if tool_name == "memory.search":
            return self._request("POST", "memory/search", input_payload)
        if tool_name == "memory.history":
            return self._request("GET", "history")["value"]
        if tool_name == "memory.conflicts":
            return self._request("GET", "conflicts")["value"]
        if tool_name == "memory.resolveConflict":
            return self._request("POST", "conflicts/resolve", input_payload)["value"]
        if tool_name == "memory.syncPull":
            return self._request("POST", "sync/pull", input_payload)
        raise ValueError(f"unknown Team Memory tool: {tool_name}")

    def recall_host_memory(self, host: str, input_payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"host/{host}/recall", input_payload)["value"]

    def capture_host_memory(self, host: str, input_payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"host/{host}/capture", input_payload)["value"]

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self._transport is not None:
            return self._transport(method, path, payload)
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={
                "authorization": f"Bearer {self.token}",
                **({} if payload is None else {"content-type": "application/json"}),
            },
        )
        try:
            with request.urlopen(req, timeout=30) as response:
                body = response.read().decode("utf-8")
                return {} if body == "" else json.loads(body)
        except HTTPError as exc:
            body = exc.read().decode("utf-8")
            raise TeamMemoryHttpError(
                exc.code,
                {} if body == "" else json.loads(body),
            ) from exc

    def _required_string(self, payload: dict[str, Any], key: str) -> str:
        value = payload.get(key)
        if not isinstance(value, str) or value == "":
            raise ValueError(f"{key} is required")
        return value


class TeamMemoryLocalError(RuntimeError):
    def __init__(self, command: list[str], status: int, stderr: str) -> None:
        self.command = command
        self.status = status
        self.stderr = stderr
        super().__init__(
            f"local Team Memory command failed with exit code {status}: {stderr.strip()}"
        )


class TeamMemoryLocalClient:
    """Local no-server client for Hermes and Python hosts.

    This client preserves the same Python-facing shape as TeamMemoryHttpClient,
    but invokes the repository's local Team Memory runtime in-process through
    the Node CLI bridge. The session token is still authoritative; there is no
    HTTP server and no sync/cloud authority involved.
    """

    def __init__(
        self,
        token: str,
        repo_root: str | Path | None = None,
        command: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.token = token
        self.repo_root = Path(repo_root) if repo_root is not None else Path(__file__).resolve().parents[3]
        self.command = command
        self.env = env

    def identity(self) -> dict[str, Any]:
        return self._run_json(["identity"])

    def list_tools(self) -> list[dict[str, Any]]:
        return self._run_json(["tools"])

    def call_tool(self, tool_name: str, input_payload: dict[str, Any]) -> dict[str, Any]:
        result = self._run_json(["call", tool_name, json.dumps(input_payload)])
        if isinstance(result, dict) and set(result.keys()) == {"value"}:
            value = result["value"]
            if isinstance(value, dict):
                return value
        return result

    def recall_host_memory(self, host: str, input_payload: dict[str, Any]) -> dict[str, Any]:
        return self._run_json(["host-recall", host, json.dumps(input_payload)])

    def capture_host_memory(self, host: str, input_payload: dict[str, Any]) -> dict[str, Any]:
        return self._run_json(["host-capture", host, json.dumps(input_payload)])

    def _run_json(self, args: list[str]) -> Any:
        env = {
            **os.environ,
            **(self.env or {}),
            "LOCAL_SESSION_TOKEN": self.token,
        }
        command = self.command or self._default_command()
        completed = subprocess.run(
            [*command, *args],
            cwd=self.repo_root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise TeamMemoryLocalError(
                [*command, *args],
                completed.returncode,
                completed.stderr,
            )
        return json.loads(completed.stdout)

    def _default_command(self) -> list[str]:
        npm = shutil.which("npm.cmd") or shutil.which("npm") or "npm"
        return [npm, "run", "--silent", "local-memory-tool", "--"]


class HermesMemoryHttpAdapter(HermesMemoryAdapter):
    """Hermes adapter that connects directly to a deployed Team Memory gateway."""

    def __init__(self, base_url: str, token: str) -> None:
        client = TeamMemoryHttpClient(base_url, token)
        super().__init__(
            lambda _token: client.identity(),
            lambda _token: client.list_tools(),
            lambda _token, name, payload: client.call_tool(name, payload),
        )


class HermesMemoryLocalAdapter(HermesMemoryAdapter):
    """Hermes adapter that connects to a local no-server Team Memory runtime."""

    def __init__(
        self,
        token: str,
        repo_root: str | Path | None = None,
        command: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        client = TeamMemoryLocalClient(
            token,
            repo_root=repo_root,
            command=command,
            env=env,
        )
        super().__init__(
            lambda _token: client.identity(),
            lambda _token: client.list_tools(),
            lambda _token, name, payload: client.call_tool(name, payload),
        )


class HermesTeamMemoryProvider:
    """Hermes memory-provider adapter with a mem0-style recall/add shape."""

    def __init__(self, client: TeamMemoryHttpClient) -> None:
        self._client = client

    @classmethod
    def from_http(cls, base_url: str, token: str) -> "HermesTeamMemoryProvider":
        return cls(TeamMemoryHttpClient(base_url, token))

    @classmethod
    def from_local(
        cls,
        token: str,
        repo_root: str | Path | None = None,
        env: dict[str, str] | None = None,
    ) -> "HermesTeamMemoryProvider":
        return cls(TeamMemoryLocalClient(token, repo_root=repo_root, env=env))

    def recall_context(
        self,
        user_message: str,
        session_id: str = "hermes",
        recent_messages: list[dict[str, str]] | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "sessionId": session_id,
            "userPrompt": user_message,
        }
        if recent_messages is not None:
            payload["recentMessages"] = recent_messages
        if limit is not None:
            payload["limit"] = limit
        context = self._client.recall_host_memory("hermes", payload)
        return {
            "tag": "memory-context",
            "content": context["text"],
            "memoryIds": context["memoryIds"],
            "provenance": context["provenance"],
        }

    def search(
        self,
        query: str,
        user_id: str | None = None,
        limit: int | None = None,
        **metadata: Any,
    ) -> dict[str, Any]:
        session_id = str(metadata.get("session_id") or user_id or "hermes")
        return self.recall_context(query, session_id=session_id, limit=limit)

    def add(
        self,
        messages: str | list[dict[str, str]],
        user_id: str | None = None,
        outcome: str = "success",
        **metadata: Any,
    ) -> dict[str, Any]:
        session_id = str(metadata.get("session_id") or user_id or "hermes")
        if isinstance(messages, str):
            final_message = messages
            user_prompt = metadata.get("user_prompt")
        else:
            user_prompt = next(
                (
                    message.get("content")
                    for message in messages
                    if message.get("role") == "user"
                ),
                None,
            )
            final_message = next(
                (
                    message.get("content")
                    for message in reversed(messages)
                    if message.get("role") == "assistant"
                ),
                "",
            )
        payload: dict[str, Any] = {
            "sessionId": session_id,
            "outcome": outcome,
            "finalAssistantMessage": final_message,
        }
        if isinstance(user_prompt, str):
            payload["userPrompt"] = user_prompt
        if "error_summary" in metadata:
            payload["errorSummary"] = metadata["error_summary"]
        return self._client.capture_host_memory("hermes", payload)
