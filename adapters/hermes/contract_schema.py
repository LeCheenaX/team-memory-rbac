import json
from pathlib import Path
from typing import Any


CONTRACT_SCHEMA_PATH = (
    Path(__file__).resolve().parents[2]
    / "contracts"
    / "team-memory-rbac.schema.json"
)


def load_contract_schema() -> dict[str, Any]:
    with CONTRACT_SCHEMA_PATH.open(encoding="utf-8") as schema_file:
        return json.load(schema_file)
