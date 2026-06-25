# TypeScript core with a Python Hermes adapter

Status: accepted

The RBAC and Memory core, persistence adapters, HTTP transport, and MCP server will be implemented in TypeScript. Claude Code, Codex, and other protocol-level integrations will consume those transports; OpenClaw can use a native TypeScript plugin. Hermes-specific native integration will use a thin Python adapter that calls the same core interfaces and must not duplicate authorization or memory-domain rules.

This choice favors one strongly typed implementation for permission constraints, memory operations, and cross-platform contracts while still matching Hermes' Python runtime where native integration is required.
