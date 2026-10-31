# Task list (see plan.md for context)

## Phase 1: Foundation and highest-risk fix

### T1 [DONE]: Test harness and `lib/guards.js` extraction
**Description:** Add `node:test` and move `opType`, `accessLevel`, `safeEq` and the mutation check into `lib/guards.js` with no behaviour change, so later tasks are test-driven.
- [ ] `npm test` runs `node --test` and passes
- [ ] Tests cover: read key vs write key vs wrong key, equal-secret rejection, `opType` for query/mutation/anonymous/comment-prefixed documents
- [ ] `server.js` imports from `lib/guards.js`; responses unchanged
**Verification:** `npm test`; `node --check server.js`; start locally with dummy env and `curl /` returns ok
**Dependencies:** None | **Files:** `lib/guards.js`, `test/guards.test.js`, `server.js`, `package.json` | **Scope:** S

### T2: Replace mutation blocklist with parsed allowlist
**Description:** Use `graphql` `parse()` to read root fields. The write tool accepts only allowlisted root mutation fields; the read tool accepts only `query` operations. Delete `BLOCKED_MUTATIONS`.
- [ ] Refused with a message naming the field: `bulkOperationRunMutation` (even with the mutation passed via variables), `orderCancel`, `themePublish`, any non-allowlisted field, aliased (`a: orderCancel`) and fragment-wrapped forms
- [ ] Allowed: each default-allowlist field; multi-field mutation refused if any root field is not allowed
- [ ] Documents that fail to parse return a clear error, not a 500; subscriptions refused
- [ ] Optional `MUTATION_ALLOWLIST` env overrides the default list
**Verification:** `npm test` (table-driven cases above); after deploy, send a blocked mutation through the write connector and confirm it is refused before reaching Shopify
**Dependencies:** T1 | **Files:** `lib/guards.js`, `test/guards.test.js`, `server.js`, `package.json`, `package-lock.json` | **Scope:** M

### Checkpoint: Guards
- [ ] Tests pass, human approves default allowlist (open questions 1-2)

## Phase 2: Hardening and reliability

### T3: Request hardening
**Description:** Rate-limit `/mcp/*` and `/auth/*`, make `GET /` return only `{ok:true}`, escape reflected text in the OAuth callback, set `trust proxy`, disable `x-powered-by`.
- [ ] 11th bad-key request in a minute from one client gets 429; valid traffic unaffected
- [ ] `GET /` no longer lists store keys
- [ ] Callback error text is HTML-escaped
**Verification:** `npm test` (supertest-free: start app on ephemeral port in test); manual curl loop against local server
**Dependencies:** T1 | **Files:** `server.js`, `package.json`, `test/http.test.js` | **Scope:** M

### T4: Audit log for mutations
**Description:** One stdout JSON line per mutation attempt: time, store key, access level, root field names, allowed/refused. Never variables, query text or query string.
- [ ] Allowed and refused mutations each log one line
- [ ] Test asserts log line contains no variable values or key material
**Verification:** `npm test`; check Railway logs after deploy
**Dependencies:** T2 | **Files:** `lib/audit.js`, `server.js`, `test/audit.test.js` | **Scope:** S

### T5: Upstream reliability
**Description:** 30 s timeout on Shopify fetch; retry `THROTTLED` once with backoff for queries only; truncate responses over ~200 KB with a pagination hint; include `extensions.cost` when present.
- [ ] Hung upstream returns a timeout error within ~30 s
- [ ] THROTTLED query retried once; THROTTLED mutation is never retried
- [ ] Oversized response truncated with notice
**Verification:** `npm test` with a stubbed `fetch`
**Dependencies:** T1 | **Files:** `lib/shopify.js`, `server.js`, `test/shopify.test.js` | **Scope:** M

### Checkpoint: Hardening
- [ ] Tests green, deployed, GNBC read and write connectors smoke-tested, logs clean of secrets

## Phase 3: Usefulness and hygiene

### T6: Tool annotations and descriptions
**Description:** Mark `graphql_query` read-only and `graphql_mutation` destructive via MCP annotations; add example queries, pagination and bulk-operation guidance to descriptions.
- [ ] `tools/list` shows the annotations
- [ ] Description includes at least one paginated query example
**Verification:** `npm test` (call `tools/list` through the SDK client); confirm in claude.ai that write calls prompt for approval
**Dependencies:** T2 | **Files:** `server.js`, `test/tools.test.js` | **Scope:** S

### T7: CI
**Description:** GitHub Actions on PRs: `npm ci`, `npm test`, `npm audit --audit-level=high`.
- [ ] Workflow runs and passes on a PR
**Verification:** open PR, confirm green check
**Dependencies:** T1 | **Files:** `.github/workflows/ci.yml` | **Scope:** XS

### T8: Docs and read-only app guide
**Description:** README documents the allowlist, env vars, audit log, rate limits; add a short guide for a second read-only Dev Dashboard app (open question 3).
- [ ] README matches shipped behaviour
- [ ] Guide lists exact scopes for the read-only app
**Verification:** read through against code; human review
**Dependencies:** T2-T6 | **Files:** `README.md` | **Scope:** XS

### Checkpoint: Complete
- [ ] All acceptance criteria met, human sign-off
