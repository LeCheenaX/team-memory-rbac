import unittest
import sys
import tempfile
import textwrap
from pathlib import Path

from src.adapters.hermes.contract_schema import load_contract_schema
from src.adapters.hermes.session_context import (
    HermesMemoryAdapter,
    map_principal_context,
)
from src.adapters.hermes.http_client import (
    HermesMemoryLocalAdapter,
    HermesTeamMemoryProvider,
    TeamMemoryHttpClient,
    TeamMemoryLocalClient,
)


class ContractSchemaTest(unittest.TestCase):
    def test_python_adapter_can_consume_generated_contract(self) -> None:
        schema = load_contract_schema()

        self.assertEqual(
            schema["$defs"]["MemoryRelationType"]["enum"],
            [
                "has",
                "depends_on",
                "relates_to",
                "refers_to",
                "contradicts",
                "supersedes",
                "next_is",
            ],
        )
        self.assertIn("PermissionRequest", schema["$defs"])
        self.assertIn("PermissionDecision", schema["$defs"])
        self.assertIn("Role", schema["$defs"])
        self.assertIn("AgentDelegation", schema["$defs"])
        self.assertIn("MemoryCommit", schema["$defs"])
        self.assertIn("MemoryOperation", schema["$defs"])
        self.assertIn("PrincipalContext", schema["$defs"])

    def test_python_adapter_maps_principal_context_without_domain_logic(self) -> None:
        context = map_principal_context(
            {
                "sessionId": "session-1",
                "userId": "user-alice",
                "agentId": "agent-read",
                "rootEntityId": "root-project-a",
                "taskScope": {"rootEntityId": "root-project-a"},
                "delegationId": "delegation-read",
            }
        )

        self.assertEqual(context.user_id, "user-alice")
        self.assertEqual(context.delegation_id, "delegation-read")

    def test_hermes_adapter_only_maps_protocol_and_lifecycle(self) -> None:
        adapter = HermesMemoryAdapter(
            resolve_principal=lambda token: {
                "sessionId": token,
                "userId": "user-alice",
                "agentId": "agent-read",
                "rootEntityId": "root-project-a",
                "taskScope": {"rootEntityId": "root-project-a"},
            },
            list_tools=lambda token: [{"name": f"read:{token}"}],
            invoke_tool=lambda token, name, payload: {
                "token": token,
                "name": name,
                "payload": payload,
            },
        )

        self.assertEqual(
            adapter.resolve_principal("session-1").user_id,
            "user-alice",
        )
        self.assertEqual(
            adapter.list_tools("session-1"),
            [{"name": "read:session-1"}],
        )
        self.assertEqual(
            adapter.invoke_tool("session-1", "memory.read", {"id": "x"}),
            {
                "token": "session-1",
                "name": "memory.read",
                "payload": {"id": "x"},
            },
        )

    def test_hermes_adapter_exposes_parallel_and_replacement_memory_modes(self) -> None:
        adapter = HermesMemoryAdapter(
            resolve_principal=lambda token: {
                "sessionId": token,
                "userId": "user-alice",
                "agentId": "agent-read",
                "rootEntityId": "root-project-a",
                "taskScope": {"rootEntityId": "root-project-a"},
            },
            list_tools=lambda token: [
                {"name": "memory.search"},
                {"name": "memory.write"},
            ],
            invoke_tool=lambda token, name, payload: {},
        )

        self.assertEqual(
            adapter.supported_memory_modes,
            [
                "parallel_native_team_memory",
                "team_memory_replaces_native",
            ],
        )
        parallel = adapter.create_memory_integration_plan(
            "session-1",
            "parallel_native_team_memory",
        )
        self.assertEqual(
            parallel["nativeMemory"]["disposition"],
            "preserved",
        )
        self.assertEqual(parallel["teamMemory"]["canRead"], True)
        self.assertEqual(parallel["teamMemory"]["canWrite"], True)

        replacement = adapter.create_memory_integration_plan(
            "session-1",
            "team_memory_replaces_native",
        )
        self.assertEqual(
            replacement["nativeMemory"]["disposition"],
            "replaced_by_team_memory",
        )

    def test_http_client_backs_hermes_adapter_without_rbac_logic(self) -> None:
        calls: list[tuple[str, str, dict | None]] = []

        def transport(method: str, path: str, payload: dict | None) -> dict:
            calls.append((method, path, payload))
            if path == "identity":
                return {
                    "sessionId": "session-http",
                    "userId": "user-http",
                    "agentId": "agent-http",
                    "rootEntityId": "root-http",
                    "taskScope": {"rootEntityId": "root-http"},
                }
            if path == "agent/tools":
                return {
                    "value": [
                        {"name": "memory.search"},
                        {"name": "memory.catalog"},
                        {"name": "memory.write"},
                    ]
                }
            if path == "memory/search":
                return {"value": {"items": [{"id": "entity-http"}]}}
            if path == "memory/catalog":
                return {
                    "value": {
                        "rootName": "root-http",
                        "entities": [{"name": "entity-http"}],
                        "tags": [{"tag": "guide", "count": 1, "names": ["entity-http"]}],
                    }
                }
            raise AssertionError(path)

        client = TeamMemoryHttpClient(
            "https://memory.example",
            "token",
            transport=transport,
        )
        self.assertEqual(client.identity()["agentId"], "agent-http")
        self.assertEqual(client.list_tools()[0]["name"], "memory.search")
        self.assertEqual(
            client.call_tool(
                "memory.search",
                {"query": "http"},
            )["value"]["items"][0]["id"],
            "entity-http",
        )
        self.assertEqual(
            client.call_tool("memory.catalog", {})["entities"][0]["name"],
            "entity-http",
        )
        self.assertEqual(calls[0], ("GET", "identity", None))
        self.assertEqual(calls[2][0], "POST")

    def test_http_client_unwraps_server_identity_payloads(self) -> None:
        def transport(method: str, path: str, payload: dict | None) -> dict:
            if path == "identity":
                return {
                    "value": {
                        "sessionId": "session-http",
                        "userId": "user-http",
                        "agentId": "agent-http",
                        "rootEntityId": "root-http",
                        "taskScope": {"rootEntityId": "root-http"},
                    }
                }
            raise AssertionError(path)

        client = TeamMemoryHttpClient(
            "https://memory.example",
            "token",
            transport=transport,
        )
        self.assertEqual(client.identity()["agentId"], "agent-http")

    def test_hermes_provider_uses_lifecycle_recall_and_capture(self) -> None:
        calls: list[tuple[str, str, dict | None]] = []

        def transport(method: str, path: str, payload: dict | None) -> dict:
            calls.append((method, path, payload))
            if path == "host/hermes/recall":
                return {
                    "value": {
                        "text": "<team-memory-context>Hermes memory</team-memory-context>",
                        "memoryIds": ["memory-1"],
                        "provenance": [
                            {
                                "memoryId": "memory-1",
                                "source": "history",
                                "score": 1.0,
                            }
                        ],
                    }
                }
            if path == "host/hermes/capture":
                return {
                    "value": {
                        "status": "captured",
                        "entityId": "entity-1",
                        "branchId": "branch-1",
                        "commitIds": ["commit-1"],
                    }
                }
            if path == "memory/search":
                return {"value": {"items": [{"id": "entity-filtered"}]}}
            if path == "memory/catalog":
                return {
                    "value": {
                        "rootName": "root-hermes",
                        "entities": [{"name": "entity-filtered"}],
                        "tags": [{"tag": "hermes", "count": 1, "names": ["entity-filtered"]}],
                    }
                }
            raise AssertionError(path)

        provider = HermesTeamMemoryProvider(
            TeamMemoryHttpClient(
                "https://memory.example",
                "token",
                transport=transport,
            )
        )

        recalled = provider.search(
            "Hermes memory",
            user_id="hermes-user",
            limit=3,
        )
        self.assertEqual(recalled["tag"], "memory-context")
        self.assertEqual(recalled["memoryIds"], ["memory-1"])
        self.assertEqual(calls[0][1], "host/hermes/recall")
        self.assertEqual(calls[0][2]["sessionId"], "hermes-user")

        filtered = provider.search(
            "Hermes memory",
            user_id="hermes-user",
            names=["entity-filtered"],
            tagsAny=["hermes"],
        )
        self.assertEqual(filtered["value"]["items"][0]["id"], "entity-filtered")
        self.assertEqual(calls[1][1], "memory/search")
        self.assertEqual(calls[1][2]["query"], "Hermes memory")
        self.assertEqual(calls[1][2]["names"], ["entity-filtered"])
        self.assertEqual(calls[1][2]["tagsAny"], ["hermes"])

        captured = provider.add(
            [
                {"role": "user", "content": "do the work"},
                {"role": "assistant", "content": "done"},
            ],
            user_id="hermes-user",
            outcome="success",
        )
        self.assertEqual(captured["status"], "captured")
        self.assertEqual(calls[2][1], "host/hermes/capture")
        self.assertEqual(calls[2][2]["finalAssistantMessage"], "done")

        catalog = provider.catalog()
        self.assertEqual(catalog["tags"][0]["tag"], "hermes")

    def test_hermes_provider_validates_agent_identity_and_catalog_tool(self) -> None:
        def valid_transport(method: str, path: str, payload: dict | None) -> dict:
            if path == "identity":
                return {
                    "sessionId": "session-http",
                    "userId": "user-http",
                    "agentId": "agent-http",
                    "rootEntityId": "root-http",
                    "taskScope": {"rootEntityId": "root-http"},
                }
            if path == "agent/tools":
                return {"value": [{"name": "memory.catalog"}]}
            raise AssertionError(path)

        provider = HermesTeamMemoryProvider(
            TeamMemoryHttpClient(
                "https://memory.example",
                "token",
                transport=valid_transport,
            )
        )
        self.assertEqual(provider.validate_session(), None)

        def user_transport(method: str, path: str, payload: dict | None) -> dict:
            if path == "identity":
                return {
                    "sessionId": "session-http",
                    "userId": "user-http",
                    "rootEntityId": "root-http",
                    "taskScope": {"rootEntityId": "root-http"},
                }
            if path == "agent/tools":
                return {"value": []}
            raise AssertionError(path)

        user_provider = HermesTeamMemoryProvider(
            TeamMemoryHttpClient(
                "https://memory.example",
                "token",
                transport=user_transport,
            )
        )
        with self.assertRaisesRegex(RuntimeError, "agent session"):
            user_provider.validate_session()

        def no_catalog_transport(method: str, path: str, payload: dict | None) -> dict:
            if path == "identity":
                return {
                    "sessionId": "session-http",
                    "userId": "user-http",
                    "agentId": "agent-http",
                    "rootEntityId": "root-http",
                    "taskScope": {"rootEntityId": "root-http"},
                }
            if path == "agent/tools":
                return {"value": [{"name": "memory.search"}]}
            raise AssertionError(path)

        no_catalog_provider = HermesTeamMemoryProvider(
            TeamMemoryHttpClient(
                "https://memory.example",
                "token",
                transport=no_catalog_transport,
            )
        )
        with self.assertRaisesRegex(RuntimeError, "memory.catalog"):
            no_catalog_provider.validate_session()

    def test_local_client_backs_hermes_without_an_http_server(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            bridge = Path(directory) / "local_bridge.py"
            bridge.write_text(
                textwrap.dedent(
                    """
                    import json
                    import os
                    import sys

                    assert os.environ["LOCAL_SESSION_TOKEN"] == "local-token"
                    args = sys.argv[1:]
                    if args[0] == "identity":
                        print(json.dumps({
                            "sessionId": "session-local",
                            "userId": "user-local",
                            "agentId": "agent-local",
                            "rootEntityId": "root-local",
                            "taskScope": {"rootEntityId": "root-local"},
                        }))
                    elif args[0] == "tools":
                        print(json.dumps([
                            {"name": "memory.search"},
                            {"name": "memory.write"},
                        ]))
                    elif args[0] == "call":
                        print(json.dumps({
                            "decision": {"allowed": True},
                            "value": {"tool": args[1], "payload": json.loads(args[2])},
                        }))
                    elif args[0] == "host-recall":
                        print(json.dumps({
                            "text": "<team-memory-context>local Hermes memory</team-memory-context>",
                            "memoryIds": ["memory-local"],
                            "provenance": [],
                        }))
                    elif args[0] == "host-capture":
                        print(json.dumps({
                            "status": "captured",
                            "entityId": "entity-local",
                            "branchId": "branch-local",
                            "commitIds": ["commit-local"],
                        }))
                    else:
                        raise AssertionError(args)
                    """
                ),
                encoding="utf-8",
            )

            client = TeamMemoryLocalClient(
                "local-token",
                repo_root=directory,
                command=[sys.executable, str(bridge)],
            )
            self.assertEqual(client.identity()["rootEntityId"], "root-local")
            self.assertEqual(client.list_tools()[1]["name"], "memory.write")
            self.assertEqual(
                client.call_tool("memory.search", {"query": "local"})["value"]["tool"],
                "memory.search",
            )

            adapter = HermesMemoryLocalAdapter(
                "local-token",
                repo_root=directory,
                command=[sys.executable, str(bridge)],
                env={},
            )
            adapter_client = adapter.resolve_principal("local-token")
            self.assertEqual(adapter_client.root_entity_id, "root-local")

            provider = HermesTeamMemoryProvider(client)
            recalled = provider.search("local", user_id="hermes-local")
            self.assertEqual(recalled["memoryIds"], ["memory-local"])
            captured = provider.add(
                [{"role": "assistant", "content": "done locally"}],
                user_id="hermes-local",
            )
            self.assertEqual(captured["status"], "captured")


if __name__ == "__main__":
    unittest.main()
