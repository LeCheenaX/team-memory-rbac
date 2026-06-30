import unittest

from src.adapters.hermes.contract_schema import load_contract_schema
from src.adapters.hermes.session_context import (
    HermesMemoryAdapter,
    map_principal_context,
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
            "not_applicable",
        )
        self.assertEqual(parallel["teamMemory"]["canRead"], True)
        self.assertEqual(parallel["teamMemory"]["canWrite"], True)

        replacement = adapter.create_memory_integration_plan(
            "session-1",
            "team_memory_replaces_native",
        )
        self.assertEqual(
            replacement["nativeMemory"]["disposition"],
            "not_applicable",
        )


if __name__ == "__main__":
    unittest.main()
