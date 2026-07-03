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

For Hermes memory-provider plugins, register the Team Memory provider at the
same seam as mem0-style memory modules:

```python
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http(
    "https://team-memory.example.com",
    "agent-session-token",
)
```

All reads, writes, resource imports, history, conflict, and sync calls route
through the TypeScript gateway. The Hermes layer does not make RBAC decisions.
