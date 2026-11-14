import { cache } from "react";
import type { Value } from "@/engine/expression";
import { asUser, getDb, type Sql } from "./db";

/** All reads run as the signed-in user, so RLS decides what comes back. */
export async function withUser<T>(uid: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await asUser(tx, uid);
    return fn(tx);
  });
}

export type Role = "owner" | "admin" | "editor" | "approver" | "viewer";
export const ROLES: Role[] = ["owner", "admin", "editor", "approver", "viewer"];
export const can = {
  edit: (r: Role) => r === "owner" || r === "admin" || r === "editor",
  run: (r: Role) => r === "owner" || r === "admin" || r === "editor",
  approve: (r: Role) => r === "owner" || r === "admin" || r === "approver",
  admin: (r: Role) => r === "owner" || r === "admin",
};

export interface OrgSummary { id: string; name: string; role: Role }

export const listOrgs = cache(async (uid: string) =>
  withUser(uid, async (tx) =>
    (await tx.query<OrgSummary>(
      "select o.id, o.name, m.role from organizations o join org_members m on m.org_id = o.id and m.user_id = $1 order by o.created_at", [uid],
    )).rows,
  ),
);

export const getOrg = cache(async (uid: string, orgId: string): Promise<(OrgSummary & { pending: number }) | null> => {
  if (!isUuid(orgId)) return null;
  return withUser(uid, async (tx) => {
    const { rows } = await tx.query<OrgSummary & { pending: number }>(
      `select o.id, o.name, m.role,
        (select count(*)::int from approvals a where a.org_id = o.id and a.status = 'pending') as pending
       from organizations o join org_members m on m.org_id = o.id and m.user_id = $2 where o.id = $1`, [orgId, uid]);
    return rows[0] ?? null;
  });
});

export function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export interface WorkflowRow {
  id: string; name: string; description: string; updated_at: Date; published_version: number | null; runs: number;
}
export async function listWorkflows(uid: string, orgId: string) {
  return withUser(uid, async (tx) =>
    (await tx.query<WorkflowRow>(
      `select w.id, w.name, w.description, w.updated_at, v.version as published_version,
        (select count(*)::int from executions e where e.workflow_id = w.id) as runs
       from workflows w left join workflow_versions v on v.id = w.published_version_id
       where w.org_id = $1 order by w.updated_at desc`, [orgId])).rows);
}

export async function getWorkflow(uid: string, id: string) {
  if (!isUuid(id)) return null;
  return withUser(uid, async (tx) => {
    const { rows } = await tx.query<{ id: string; org_id: string; name: string; description: string; draft_graph: unknown; published_version_id: string | null }>(
      "select id, org_id, name, description, draft_graph, published_version_id from workflows where id = $1", [id]);
    if (!rows[0]) return null;
    const versions = await tx.query<{ id: string; version: number; published_at: Date; published_by: string; graph: unknown }>(
      `select v.id, v.version, v.published_at, p.display_name as published_by, v.graph from workflow_versions v
       left join profiles p on p.id = v.published_by where v.workflow_id = $1 order by v.version desc`, [id]);
    return { ...rows[0], versions: versions.rows };
  });
}

export interface ExecutionRow {
  id: string; status: string; workflow_id: string; workflow_name: string; version: number;
  started_at: Date; finished_at: Date | null; started_by: string; error: string | null;
}
export async function listExecutions(uid: string, orgId: string, status?: string) {
  return withUser(uid, async (tx) =>
    (await tx.query<ExecutionRow>(
      `select e.id, e.status, e.workflow_id, w.name as workflow_name, v.version, e.started_at, e.finished_at, e.error,
              coalesce(p.display_name, '—') as started_by
       from executions e join workflows w on w.id = e.workflow_id join workflow_versions v on v.id = e.version_id
       left join profiles p on p.id = e.started_by
       where e.org_id = $1 and ($2::text is null or e.status = $2) order by e.started_at desc limit 200`,
      [orgId, status ?? null])).rows);
}

export async function getExecution(uid: string, id: string) {
  if (!isUuid(id)) return null;
  return withUser(uid, async (tx) => {
    const { rows } = await tx.query<ExecutionRow & { org_id: string; input: Record<string, Value>; vars: Record<string, Value>; next_run_at: Date | null; graph: unknown; idempotency_key: string | null }>(
      `select e.*, w.name as workflow_name, v.version, v.graph, coalesce(p.display_name, '—') as started_by
       from executions e join workflows w on w.id = e.workflow_id join workflow_versions v on v.id = e.version_id
       left join profiles p on p.id = e.started_by where e.id = $1`, [id]);
    if (!rows[0]) return null;
    const steps = await tx.query<{ id: string; node_id: string; node_type: string; seq: number; status: string; attempt: number; max_attempts: number; output: Value; error: string | null; run_after: Date | null; started_at: Date | null; finished_at: Date | null }>(
      "select * from execution_steps where execution_id = $1 order by seq", [id]);
    const logs = await tx.query<{ id: number; step_id: string | null; level: string; message: string; data: Value; created_at: Date }>(
      "select id, step_id, level, message, data, created_at from execution_logs where execution_id = $1 order by id", [id]);
    const approvals = await tx.query<{ id: string; step_id: string; title: string; status: string; decided_by: string | null; decided_at: Date | null; comment: string | null }>(
      `select a.id, a.step_id, a.title, a.status, p.display_name as decided_by, a.decided_at, a.comment
       from approvals a left join profiles p on p.id = a.decided_by where a.execution_id = $1`, [id]);
    return { ...rows[0], steps: steps.rows, logs: logs.rows, approvals: approvals.rows };
  });
}

export async function listApprovals(uid: string, orgId: string, status: "pending" | "decided") {
  return withUser(uid, async (tx) =>
    (await tx.query<{ id: string; title: string; instructions: string; status: string; created_at: Date; execution_id: string; workflow_name: string; input: Record<string, Value>; decided_by: string | null; comment: string | null }>(
      `select a.id, a.title, a.instructions, a.status, a.created_at, a.execution_id, w.name as workflow_name, e.input,
              p.display_name as decided_by, a.comment
       from approvals a join executions e on e.id = a.execution_id join workflows w on w.id = e.workflow_id
       left join profiles p on p.id = a.decided_by
       where a.org_id = $1 and (case when $2 = 'pending' then a.status = 'pending' else a.status <> 'pending' end)
       order by a.created_at desc limit 100`, [orgId, status])).rows);
}

export async function listMembers(uid: string, orgId: string) {
  return withUser(uid, async (tx) =>
    (await tx.query<{ user_id: string; email: string; display_name: string; role: Role }>(
      `select m.user_id, p.email, p.display_name, m.role from org_members m join profiles p on p.id = m.user_id
       where m.org_id = $1 order by m.created_at`, [orgId])).rows);
}

export async function listAudit(uid: string, orgId: string) {
  return withUser(uid, async (tx) =>
    (await tx.query<{ id: number; action: string; entity_type: string; entity_id: string; data: Value; created_at: Date; actor: string | null }>(
      `select a.id, a.action, a.entity_type, a.entity_id, a.data, a.created_at, p.display_name as actor
       from audit_events a left join profiles p on p.id = a.actor_id where a.org_id = $1 order by a.id desc limit 200`, [orgId])).rows);
}
