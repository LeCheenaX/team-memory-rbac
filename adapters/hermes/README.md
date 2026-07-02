# Hermes Team Memory Adapter

Install this repository as a Python package or vendor `src.adapters.hermes`.
Hermes hosts should construct `HermesMemoryHttpAdapter` with the deployed
Team Memory gateway URL and an agent session token:

```python
from src.adapters.hermes.http_client import HermesMemoryHttpAdapter

memory = HermesMemoryHttpAdapter(
    "https://team-memory.example.com",
    "agent-session-token",
)
```

All reads, writes, resource imports, history, conflict, and sync calls route
through the TypeScript gateway. The Hermes layer does not make RBAC decisions.
