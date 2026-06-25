## Agent skills

### Issue tracker

Issues and PRDs are tracked as local markdown files under `.scratch/`; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

This repo uses the default mattpocock/skills triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain doc layout: `CONTEXT.md` at the repo root and ADRs under `docs/adr/`. See `docs/agents/domain.md`.

### Directory boundaries

Production code lives under `src/` and production platform adapters live under `adapters/`. Tests, fixtures, fakes, and all other test support code live under the top-level `test/` directory. Production entry points must not export test support modules.
