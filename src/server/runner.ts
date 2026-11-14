import { randomUUID } from "node:crypto";
import { advance, createExecution, EngineError, type AdvanceResult, type EngineEvent, type ExecutionState, type Step } from "@/engine/engine";
import type { Value } from "@/engine/expression";
import { graphSchema, nodeData, validateGraph, type Graph, type GraphNode } from "@/engine/graph";
import { asOwner, asUser, type Db, type Sql } from "./db";

/**
 * Persists the pure engine against Postgres. Every command:
 *   1. checks permission as the caller (RLS + private.can_* helpers),
 *   2. switches to the owner role and locks the execution row (FOR UPDATE),
 *   3. loads state, calls the engine, and writes the result in the same transaction.
 * Concurrent commands on one execution therefore serialise on the row lock.
 */

export class RunnerError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

export interface RunOptions {
  now?: () => Date;
}

type ExecRow = {
  id: string;
  org_id: string;
  status: ExecutionState["status"];
  input: Record<string, Value>;
  vars: Record<string, Value>;
  error: string | null;
  next_run_at: string | Date | null;
  finished_at: string | Date | null;
  graph: unknown;
};

const toIso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

async function check(tx: Sql, fn: "can_run" | "can_approve" | "can_edit", org: string) {
  const { rows } = await tx.query<{ ok: boolean }>(`select private.${fn}($1) as ok`, [org]);
  if (!rows[0]?.ok) throw new RunnerError("You don't have permission to do that", 403);
}

async function load(tx: Sql, executionId: string, lock: "lock" | "skip" = "lock"): Promise<{ row: ExecRow; state: ExecutionState; graph: Graph } | null> {
  const { rows } = await tx.query<ExecRow>(
    `select e.id, e.org_id, e.status, e.input, e.vars, e.error, e.next_run_at, e.finished_at, v.graph
       from public.executions e join public.workflow_versions v on v.id = e.version_id
      where e.id = $1 for update of e ${lock === "skip" ? "skip locked" : ""}`,
    [executionId],
  );
  const row = rows[0];
  if (!row) return null;
  const steps = await tx.query<{
    id: string; node_id: string; node_type: Step["nodeType"]; seq: number; status: Step["status"]; attempt: number;
    max_attempts: number; idempotency_key: string; output: Value; error: string | null;
    run_after: string | Date | null; started_at: string | Date | null; finished_at: string | Date | null;
  }>("select * from public.execution_steps where execution_id = $1 order by seq", [executionId]);
  return {
    row,
    graph: graphSchema.parse(row.graph),
    state: {
      id: row.id,
      status: row.status,
      input: row.input,
      vars: row.vars,
      error: row.error,
      nextRunAt: toIso(row.next_run_at),
      finishedAt: toIso(row.finished_at),
      steps: steps.rows.map((s) => ({
        id: s.id, nodeId: s.node_id, nodeType: s.node_type, seq: s.seq, status: s.status, attempt: s.attempt,
        maxAttempts: s.max_attempts, idempotencyKey: s.idempotency_key, output: s.output ?? null, error: s.error,
        runAfter: toIso(s.run_after), startedAt: toIso(s.started_at), finishedAt: toIso(s.finished_at),
      })),
    },
  };
}

async function persist(tx: Sql, orgId: string, graph: Graph, result: AdvanceResult, isNew: boolean, extra?: { workflowId: string; versionId: string; startedBy: string; idempotencyKey: string | null }) {
  const s = result.state;
  if (isNew && extra) {
    await tx.query(
      `insert into public.executions (id, org_id, workflow_id, version_id, status, input, vars, error, idempotency_key, next_run_at, started_by, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [s.id, orgId, extra.workflowId, extra.versionId, s.status, JSON.stringify(s.input), JSON.stringify(s.vars), s.error, extra.idempotencyKey, s.nextRunAt, extra.startedBy, s.finishedAt],
    );
  } else {
    await tx.query(
      `update public.executions set status = $2, vars = $3, error = $4, next_run_at = $5, finished_at = $6, updated_at = now() where id = $1`,
      [s.id, s.status, JSON.stringify(s.vars), s.error, s.nextRunAt, s.finishedAt],
    );
  }
  for (const st of s.steps) {
    await tx.query(
      `insert into public.execution_steps (id, execution_id, org_id, node_id, node_type, seq, status, attempt, max_attempts, idempotency_key, output, error, run_after, started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict (id) do update set status = excluded.status, attempt = excluded.attempt, output = excluded.output,
         error = excluded.error, run_after = excluded.run_after, started_at = excluded.started_at, finished_at = excluded.finished_at`,
      [st.id, s.id, orgId, st.nodeId, st.nodeType, st.seq, st.status, st.attempt, st.maxAttempts, st.idempotencyKey,
        JSON.stringify(st.output), st.error, st.runAfter, st.startedAt, st.finishedAt],
    );
  }
  for (const st of result.approvalsRequested) {
    const node = graph.nodes.find((n) => n.id === st.nodeId) as GraphNode & { type: "approval" };
    const d = nodeData(node);
    await tx.query(
      `insert into public.approvals (org_id, execution_id, step_id, node_id, title, instructions) values ($1, $2, $3, $4, $5, $6)
       on conflict (step_id) do nothing`,
      [orgId, s.id, st.id, st.nodeId, d.label, d.instructions],
    );
  }
  if (s.status === "cancelled") {
    await tx.query("update public.approvals set status = 'cancelled' where execution_id = $1 and status = 'pending'", [s.id]);
  }
  for (const l of result.logs) {
    await tx.query(
      "insert into public.execution_logs (org_id, execution_id, step_id, level, message, data) values ($1, $2, $3, $4, $5, $6)",
      [orgId, s.id, l.stepId, l.level, l.message, l.data === undefined ? null : JSON.stringify(l.data)],
    );
  }
}

async function audit(tx: Sql, orgId: string, action: string, type: string, id: string, data: Record<string, unknown> = {}) {
  await tx.query("select private.audit($1, $2, $3, $4, $5)", [orgId, action, type, id, JSON.stringify(data)]);
}

const inputSchema = graphSchema.shape.nodes.element.shape.data; // record<string, unknown>

/** Starts a run of the workflow's published version. Same idempotency key → same execution. */
export async function startExecution(
  db: Db, uid: string, workflowId: string, input: unknown, idempotencyKey: string | null = null, opts: RunOptions = {},
): Promise<{ id: string; created: boolean }> {
  const parsedInput = inputSchema.safeParse(input ?? {});
  if (!parsedInput.success) throw new RunnerError("Input must be a JSON object");
  if (idempotencyKey !== null && !/^[\w:.-]{1,100}$/.test(idempotencyKey)) throw new RunnerError("Invalid idempotency key");
  return db.transaction(async (tx) => {
    await asUser(tx, uid);
    const { rows } = await tx.query<{ org_id: string; published_version_id: string | null }>(
      "select org_id, published_version_id from public.workflows where id = $1", [workflowId]);
    const wf = rows[0];
    if (!wf) throw new RunnerError("Workflow not found", 404);
    await check(tx, "can_run", wf.org_id);
    if (!wf.published_version_id) throw new RunnerError("Publish the workflow before running it", 409);
    await asOwner(tx);
    if (idempotencyKey) {
      // Serialise concurrent starts with the same key on the workflow row.
      await tx.query("select 1 from public.workflows where id = $1 for update", [workflowId]);
      const existing = await tx.query<{ id: string }>(
        "select id from public.executions where workflow_id = $1 and idempotency_key = $2", [workflowId, idempotencyKey]);
      if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    }
    const version = await tx.query<{ graph: unknown }>("select graph from public.workflow_versions where id = $1", [wf.published_version_id]);
    const graph = graphSchema.parse(version.rows[0]!.graph);
    const id = randomUUID();
    const result = createExecution(graph, id, parsedInput.data as Record<string, Value>, { now: (opts.now ?? (() => new Date()))(), newId: randomUUID });
    await persist(tx, wf.org_id, graph, result, true, { workflowId, versionId: wf.published_version_id, startedBy: uid, idempotencyKey });
    await audit(tx, wf.org_id, "execution.started", "execution", id, { workflow_id: workflowId });
    return { id, created: true };
  });
}

/** Approve or reject a pending approval. Deciding twice is rejected (409). */
export async function decideApproval(
  db: Db, uid: string, approvalId: string, decision: "approved" | "rejected", comment = "", opts: RunOptions = {},
): Promise<{ executionId: string }> {
  if (comment.length > 500) throw new RunnerError("Comment is too long");
  return db.transaction(async (tx) => {
    await asUser(tx, uid);
    const { rows } = await tx.query<{ org_id: string; execution_id: string; step_id: string }>(
      "select org_id, execution_id, step_id from public.approvals where id = $1", [approvalId]);
    const ap = rows[0];
    if (!ap) throw new RunnerError("Approval not found", 404);
    await check(tx, "can_approve", ap.org_id);
    await asOwner(tx);
    const loaded = await load(tx, ap.execution_id);
    if (!loaded) throw new RunnerError("Execution not found", 404);
    const updated = await tx.query(
      "update public.approvals set status = $2, decided_by = $3, decided_at = now(), comment = $4 where id = $1 and status = 'pending' returning id",
      [approvalId, decision, uid, comment || null]);
    if (!updated.rows.length) throw new RunnerError("This approval has already been decided", 409);
    await apply(tx, loaded, { type: "decision", stepId: ap.step_id, decision, by: uid, comment }, opts);
    await audit(tx, ap.org_id, `approval.${decision}`, "approval", approvalId, { execution_id: ap.execution_id });
    return { executionId: ap.execution_id };
  });
}

/** Cancel a running or waiting execution. */
export async function cancelExecution(db: Db, uid: string, executionId: string, opts: RunOptions = {}) {
  return userCommand(db, uid, executionId, { type: "cancel", by: uid }, opts, "execution.cancelled");
}

/** Resume: run any steps that are due now (e.g. a scheduled retry). Safe to call repeatedly. */
export async function resumeExecution(db: Db, uid: string, executionId: string, opts: RunOptions = {}) {
  return userCommand(db, uid, executionId, { type: "tick" }, opts);
}

async function userCommand(db: Db, uid: string, executionId: string, event: EngineEvent, opts: RunOptions, auditAction?: string) {
  return db.transaction(async (tx) => {
    await asUser(tx, uid);
    const { rows } = await tx.query<{ org_id: string }>("select org_id from public.executions where id = $1", [executionId]);
    if (!rows[0]) throw new RunnerError("Execution not found", 404);
    await check(tx, "can_run", rows[0].org_id);
    await asOwner(tx);
    const loaded = await load(tx, executionId);
    if (!loaded) throw new RunnerError("Execution not found", 404);
    const state = await apply(tx, loaded, event, opts);
    if (auditAction) await audit(tx, rows[0].org_id, auditAction, "execution", executionId);
    return state;
  });
}

async function apply(tx: Sql, loaded: NonNullable<Awaited<ReturnType<typeof load>>>, event: EngineEvent, opts: RunOptions) {
  try {
    const result = advance(loaded.graph, loaded.state, event, { now: (opts.now ?? (() => new Date()))(), newId: randomUUID });
    await persist(tx, loaded.row.org_id, loaded.graph, result, false);
    return result.state;
  } catch (e) {
    if (e instanceof EngineError) throw new RunnerError(e.message, 409);
    throw e;
  }
}

/**
 * Worker entry point: advances executions whose scheduled retry is due.
 * Uses FOR UPDATE SKIP LOCKED so several workers never process the same row.
 */
export async function processDue(db: Db, limit = 20, opts: RunOptions = {}): Promise<number> {
  const now = (opts.now ?? (() => new Date()))();
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `select id from public.executions where status = 'running' and next_run_at <= $1
        order by next_run_at for update skip locked limit $2`, [now.toISOString(), limit]);
    for (const r of rows) {
      const loaded = await load(tx, r.id, "skip");
      if (loaded) await apply(tx, loaded, { type: "tick" }, { now: () => now });
    }
    return rows.length;
  });
}

/** Saves a draft graph (any shape that parses; validation happens at publish). */
export async function saveDraft(db: Db, uid: string, workflowId: string, graph: unknown) {
  const parsed = graphSchema.safeParse(graph);
  if (!parsed.success) throw new RunnerError("Graph is malformed");
  return db.transaction(async (tx) => {
    await asUser(tx, uid);
    const { rows } = await tx.query("update public.workflows set draft_graph = $2 where id = $1 returning id", [workflowId, JSON.stringify(parsed.data)]);
    if (!rows.length) throw new RunnerError("Workflow not found or you can't edit it", 404);
  });
}

/** Validates the draft and snapshots it as a new immutable version. */
export async function publish(db: Db, uid: string, workflowId: string) {
  return db.transaction(async (tx) => {
    await asUser(tx, uid);
    const { rows } = await tx.query<{ draft_graph: unknown; org_id: string }>(
      "select draft_graph, org_id from public.workflows where id = $1", [workflowId]);
    if (!rows[0]) throw new RunnerError("Workflow not found", 404);
    await check(tx, "can_edit", rows[0].org_id);
    const issues = validateGraph(rows[0].draft_graph);
    if (issues.length) return { ok: false as const, issues };
    const v = await tx.query<{ id: string; version: number }>(
      "insert into public.workflow_versions (workflow_id, org_id, graph, published_by) values ($1, $2, $3, $4) returning id, version",
      [workflowId, rows[0].org_id, JSON.stringify(rows[0].draft_graph), uid]);
    return { ok: true as const, ...v.rows[0]! };
  });
}
