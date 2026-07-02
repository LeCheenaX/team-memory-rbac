import json
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


class HermesMemoryHttpAdapter(HermesMemoryAdapter):
    """Hermes adapter that connects directly to a deployed Team Memory gateway."""

    def __init__(self, base_url: str, token: str) -> None:
        client = TeamMemoryHttpClient(base_url, token)
        super().__init__(
            client.identity,
            client.list_tools,
            client.call_tool,
        )
