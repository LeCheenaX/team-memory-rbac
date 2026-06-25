import unittest

from contract_schema import load_contract_schema


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


if __name__ == "__main__":
    unittest.main()
