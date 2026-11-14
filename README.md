# FlowForge

Visual workflow automation and approvals: build a workflow on a canvas, publish an immutable version, and run it on a real backend engine with branching, human approvals, retries and a full execution history.

**Status:** runs locally end to end on an embedded Postgres (PGlite). Not deployed. No hosted database yet (see [Limits](#limits)).

## What works

| Area | Status |
|---|---|
| XYFlow editor: Start / Approval / Condition / Action / End nodes, node library, config panel, live validation with per-node highlighting | Tested (Playwright) |
| Draft vs published: drafts save freely; publish validates and snapshots an immutable, numbered version; runs pin the version they started on | Tested (Vitest + PGlite + Playwright) |
| Engine: sequential steps, condition branches, approve/reject, step state machine, idempotency keys, bounded retries with exponential backoff, resume, cancel, step limit | Tested (unit) |
| Persistence: executions, steps, approvals, logs and audit events in Postgres with row locks | Tested (PGlite) |
| Orgs with roles (owner, admin, editor, approver, viewer) enforced by RLS | Tested (PGlite + Playwright) |
| Execution history (status filter) and detail page (steps, attempts, outputs, input, variables, log) | Tested (Playwright) |
| Approval inbox with comments | Tested (Playwright) |
| Audit history (admins) | Tested (Playwright) |
| Worker endpoint `POST /api/worker` for due retries (`FOR UPDATE SKIP LOCKED`) | Logic tested via `processDue` in PGlite; route itself not exercised |
| Hosted Postgres driver (`DATABASE_URL`, postgres.js) | Implemented, not tested |

## How it works

```
src/engine/        Pure TypeScript interpreter — no I/O
  expression.ts    Safe expression language (tokenizer + Pratt parser + interpreter, no eval)
  graph.ts         Graph schema (Zod) and publish-time validation
  engine.ts        createExecution / advance(state, event) → new state, logs, approvals
src/server/
  runner.ts        Loads state under a row lock, calls the engine, persists the result
  db.ts            PGlite (local) or postgres.js (DATABASE_URL); runs migrations for PGlite
  auth.ts          Local accounts: scrypt hashes, HMAC-signed httpOnly session cookie
  queries.ts       Reads, always as the signed-in user so RLS applies
db/migrations/     Schema, RLS policies, triggers (Supabase-compatible)
db/supabase-stub.sql  auth.users / auth.uid() / roles stand-in for PGlite
```

**Engine.** `advance(graph, state, event, {now})` is deterministic. Events are `tick`, `decision` and `cancel`. Steps move `pending → running → waiting_approval → succeeded | failed | skipped`. Every step has an idempotency key `executionId:seq:nodeId` (unique in the DB). A succeeded step is never re-run, and an approval can only be decided once: the engine and a `status = 'pending'` guarded update both enforce this. Action nodes retry up to `maxAttempts` (≤ 5) with `backoffMs × 2^(attempt−1)`. Retries due within 3 s are waited out in the request; later ones are picked up by **Resume now** or the worker endpoint.

**Expressions** (Condition nodes, `set_variable` values): `input.*`, `vars.*`, literals, `== != < <= > >= && || ! + - * / %` and parentheses. Equality is strict, with no type coercion, no function calls, and no access to inherited properties (`__proto__`, `constructor` and `prototype` are rejected).

**Actions** are deliberately small: `set_variable`, `log` and `simulated_flaky` (a demo action that fails N times, used to show retries). There are **no external integrations** (no HTTP, email or Slack).

**Authorisation.** All reads run as Postgres role `authenticated`, with the user id in `request.jwt.claims`, exactly as Supabase does, so RLS decides visibility. Drafts, publishing, orgs and members are written through RLS. Execution tables have no client write privileges. The server checks `private.can_run` / `private.can_approve` as the caller, then writes as the table owner in the same transaction. Role helpers live in the non-exposed `private` schema. Published versions and audit events are immutable (enforced by triggers).

## Run locally

Requires Node 22 (`.nvmrc`).

```bash
npm install
npm run dev          # http://localhost:3004 — data persists in .data/pglite
```

Sign up, create an organization, then create a workflow from **Sample: purchase approval** and publish it. Run it with `{"amount": 50}` (auto branch) or `{"amount": 5000}` (waits in the Inbox).

Environment variables (all optional locally):

| Var | Purpose |
|---|---|
| `SESSION_SECRET` | 32+ chars; required when `NODE_ENV=production` |
| `DATABASE_URL` | Use a hosted Postgres instead of PGlite (apply `db/migrations` first) |
| `PGLITE_DIR` | Where PGlite stores data (default `.data/pglite`) |
| `WORKER_SECRET` | Enables `POST /api/worker` (Bearer token) |

## Tests

```bash
npm run lint && npm run typecheck
npm test             # Vitest: engine, expressions, validation, auth, and SQL/RLS/runner in PGlite
npm run test:e2e     # Playwright with local Chrome (channel: "chrome") against a fresh PGlite dir
```

## Limits

- **Single process locally.** PGlite is in-process Postgres with one connection, so row locks and `SKIP LOCKED` are only meaningful on a real Postgres. Execution is not distributed.
- **Not on Supabase yet.** The schema is Supabase-compatible, but using it would need a hosted project (the free org is at its limit). Moving would mean applying the migrations, setting `DATABASE_URL`, and swapping `src/server/auth.ts` for Supabase Auth. Until then, auth is local email + password.
- Workflows must be acyclic. Rejected approvals without a `rejected` branch end the run as `rejected`.
- The DB does not re-validate graphs on publish. A client writing `workflow_versions` directly could publish an invalid graph, and the engine would fail that run cleanly.
- No scheduler is bundled. Something external must call `/api/worker` for long backoffs, or users press **Resume now**.
