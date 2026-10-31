# Implementation Plan: Harden and improve shopify-mcp-hub

## Overview
`server.js` (217 lines, no tests, no CI) is live on Railway and serves per-store MCP endpoints with a read key and a write key.
This plan closes the gaps found in the code review: a bypassable mutation guard, no rate limit/audit trail/timeouts,
and no automated tests. Source of requirements: the review in this session (no separate SPEC.md exists).
Tasks are tracked in `tasks/todo.md`.

## Architecture decisions
- **Guards move to `lib/guards.js`** (pure functions: operation parsing, mutation policy, access level) so they can be unit
  tested with `node:test` without starting Express. `server.js` stays the wiring layer. No other restructuring.
- **Parse GraphQL instead of regexing it.** Add the `graphql` package (reference parser) as the one new dependency.
  The current regex blocklist cannot see variables, so `bulkOperationRunMutation($m: String!)` bypasses it. A parser lets
  us check the root fields of every operation.
- **Allowlist, not blocklist, for mutations.** Default allowlist of root mutation fields; anything else is refused with a
  message that names the field. The old blocklist is deleted, not kept alongside (an allowlist subsumes it).
- **No new runtime dependencies beyond `graphql` and `express-rate-limit`.** Timeouts, retry and truncation use built-ins.
- **Scopes stay the hard boundary.** Code guards are defence in depth; the plan documents (T8) a two-app setup for a
  physically read-only token.
- **Never log query strings, variables or tokens.** Audit lines carry store, level, operation name, root field names only.

## Dependency graph
```
T1 test harness + lib/guards.js (extract, no behaviour change)
 ├── T2 mutation allowlist (uses parser)         ← highest risk, first
 │     └── T6 tool annotations + descriptions (needs final tool set)
 ├── T3 request hardening (rate limit, / minimal, HTML escape)
 ├── T4 audit log (needs parsed root fields from T2)
 └── T5 reliability: timeout, throttle retry, response cap
T7 CI (needs T1 tests)
T8 docs + two-app ops guide (needs T2-T6 final behaviour)
```

## Task list

### Phase 1: Foundation and highest-risk fix
- [ ] T1: Test harness and `lib/guards.js` extraction (no behaviour change)
- [ ] T2: Replace mutation blocklist with parsed allowlist

### Checkpoint: Guards
- [ ] `npm test` green, `node --check` clean
- [ ] Bypass cases refused: variable-wrapped `bulkOperationRunMutation`, aliased and fragment-wrapped blocked fields
- [ ] Human reviews the default allowlist before merge

### Phase 2: Hardening and reliability
- [ ] T3: Request hardening (rate limit, minimal `/`, escape callback HTML)
- [ ] T4: Audit log for every mutation
- [ ] T5: Upstream reliability (timeout, THROTTLED retry, response cap)

### Checkpoint: Hardening
- [ ] Tests green; deployed to Railway; smoke test via GNBC read and write connectors
- [ ] Railway logs show audit lines and no secrets or query strings

### Phase 3: Usefulness and hygiene
- [ ] T6: Tool annotations and better tool descriptions
- [ ] T7: CI (tests + npm audit) on PRs
- [ ] T8: Docs and two-app (read-only token) ops guide

### Checkpoint: Complete
- [ ] All acceptance criteria met, README matches behaviour, human sign-off

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Allowlist too narrow, blocks legitimate edits | Med | Ship a sensible default; optional env override `MUTATION_ALLOWLIST` (comma list) so you can extend without a deploy of code; clear error names the refused field |
| New dependency (`graphql`) | Low | Reference implementation, widely used, pin exact version, covered by `npm audit` in T7 |
| Retrying THROTTLED repeats a write | High | Retry only queries, never mutations |
| Rate limit behind Railway proxy keys on proxy IP | Med | `app.set("trust proxy", 1)`; verify with two clients |
| Deploy breaks live connectors | Med | Each phase deploys separately; checkpoint smoke test; Railway rollback available |

## Open questions (need your call)
1. Default mutation allowlist: start with `productUpdate`, `productCreate`, `productVariantsBulkUpdate`, `inventorySetQuantities`, `metafieldsSet`, `collectionAddProducts`, `collectionCreate`, `collectionUpdate`, `discountCodeBasicCreate`, `fileUpdate`? Add or remove?
2. Should orders and customers be writable at all (e.g. `orderUpdate`, `customerUpdate`, `tagsAdd`)? Default: no.
3. Do you want a separate read-only Shopify app (T8), or accept scope-only separation?
4. Keep the `?key=` query option for the write key, or restrict write to the header only? (Connector UI constraints may decide.)
