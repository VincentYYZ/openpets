# Cursor Integration Todos

This checklist tracks Cursor implementation work. Each phase has an Oracle approval gate before moving to the next phase.

## Phase 1A — Validation spike

- [x] Validate strict JSON vs JSONC support in Cursor MCP config.
- [x] Validate whether Cursor requires restart/reload after MCP config changes.
- [x] Validate global/project precedence for duplicate `mcpServers.openpets`.
- [x] Validate duplicate server behavior across scopes. Project priority is documented; UI duplicate behavior still needs smoke-test awareness.
- [x] Validate documented stdio fields for Cursor MCP entries.
- [x] Choose final command strategy:
  - [x] direct `@open-pets/mcp@VERSION`, or
  - [ ] `@open-pets/cli@VERSION mcp`.
- [x] Smoke test real Cursor MCP connection.
- [x] Record validation results in `docs/cursor-phase-1-spec.md` and/or `docs/cursor-integration.md`.
- [x] **Oracle review/approval gate.**

## Phase 1B — `packages/cursor` core

- [x] Create `packages/cursor` package.
- [x] Add MCP entry builders.
- [x] Add config path resolution helpers with explicit `configPath`, `homeDir`, and `projectDir` inputs.
- [x] Add status/classification helpers.
- [x] Add safe read helpers.
- [x] Add safe write/remove helpers.
- [x] Add OpenPets-only preview helpers.
- [x] Add redaction helpers.
- [x] Add package build/typecheck/test/check scripts.
- [x] Add temp-file tests for missing/empty config.
- [x] Add temp-file tests for installed/needs-update/conflict/invalid/error statuses.
- [x] Add malformed schema tests.
- [x] Add symlink/non-regular/oversized file tests.
- [x] Add no-write tests for invalid/conflict states.
- [x] Add explicit replace tests preserving unrelated config.
- [x] Add backup and atomic write tests.
- [x] Add redacted preview tests, including recursive and case-insensitive redaction.
- [x] Run package checks.
- [x] **Oracle review/approval gate.**

## Phase 1C — CLI integration

- [x] Add `@open-pets/cursor` dependency to CLI if CLI consumes shared helpers.
- [x] Add `cursor` to accepted configure agents.
- [x] Implement project-local default behavior matching existing configure semantics:
  - [x] no `--cwd` → `process.cwd()/.cursor/mcp.json`;
  - [x] `--cwd` → `<cwd>/.cursor/mcp.json`.
- [x] Do not add global CLI behavior unless explicit `--global` is designed and reviewed.
- [x] Print target path, status, OpenPets-only preview, backup path, and restart/reload note.
- [x] Ensure unrelated Cursor config secrets are never printed.
- [x] Add CLI contract tests.
- [x] Run CLI/package checks.
- [x] **Oracle review/approval gate.**

## Phase 1D — Desktop Agent Setup

- [x] Add `@open-pets/cursor` dependency to desktop if desktop consumes shared helpers.
- [x] Replace Cursor “Soon” card with active config-status card.
- [x] Add Cursor detail pane.
- [x] Add pet selector.
- [x] Add install/update/replace/remove/refresh/copy-preview actions.
- [x] Use global `~/.cursor/mcp.json` only in desktop Phase 1.
- [x] Show warning that Cursor may need restart/reload.
- [x] Show warning that published `npx` mode may need npm/network/cache access.
- [x] Show warning that OpenPets edits only `mcpServers.openpets`.
- [x] Bind preload actions.
- [x] Add desktop contract checks.
- [x] Run desktop checks.
- [x] **Oracle review/approval gate.**

## Phase 1E — Full verification and docs

- [x] Run `pnpm check`.
- [x] Dogfood Cursor MCP setup locally.
- [x] Update validation log in `docs/cursor-phase-1-spec.md`.
- [ ] Update public docs/website only after real Cursor smoke succeeds. _(Deferred to separate web task.)_
- [x] Confirm package/release plumbing:
  - [x] `scripts/release-npm.mjs` publish order if needed;
  - [x] desktop packaging contract;
  - [x] package dependencies;
  - [x] workspace build/check inclusion.
- [x] **Oracle final review/approval gate.**

## Later phases — not Phase 1

### Phase 2 — Cursor rules

- [x] Draft Phase 2 rules spec in `docs/cursor-phase-2-rules-spec.md`.
- [x] **Oracle review before implementation.**
- [x] Run/record Cursor rules validation spike.
- [x] Implement `@open-pets/cursor` rules helpers.
- [x] Add CLI project-local rules install/update/remove flow.
- [x] Add desktop rules preview/copy guidance only, unless separately reviewed.
- [x] Run package and full checks.
- [x] **Oracle final review/approval gate.**

### Phase 3 — Cursor hooks

- [ ] Run hook validation spike first.
- [ ] Record payload fixtures and semantics.
- [ ] **Oracle review before implementation.**

### Phase 4 — Cursor extension/plugin

- [ ] Research extension distribution.
- [ ] **Oracle review before implementation.**
