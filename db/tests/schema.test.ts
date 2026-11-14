import { beforeAll, describe, expect, test } from "vitest";
import { e, n, purchaseGraph } from "@/engine/fixtures";
import type { Db, Sql } from "@/server/db";
import { cancelExecution, decideApproval, processDue, publish, resumeExecution, saveDraft, startExecution } from "@/server/runner";
import { as, createUser, memoryDb } from "@/server/testing";

const OWNER = "00000000-0000-4000-8000-000000000001";
const EDITOR = "00000000-0000-4000-8000-000000000002";
const APPROVER = "00000000-0000-4000-8000-000000000003";
const VIEWER = "00000000-0000-4000-8000-000000000004";
const OUTSIDER = "00000000-0000-4000-8000-000000000005";

let db: Db;
let org: string;
let wf: string;

type Row = Record<string, unknown>;
const q = async (tx: Sql, sql: string, p: unknown[] = []) => (await tx.query<Row>(sql, p)).rows;
async function failure(p: Promise<unknown>) {
  try { await p; } catch (err) { return err as { code?: string; message: string; status?: number }; }
  throw new Error("expected failure");
}
const asOwnerDb = (sql: string, p: unknown[] = []) => db.transaction((tx) => q(tx, sql, p));

beforeAll(async () => {
  db = await memoryDb();
  for (const [id, email] of [[OWNER, "o@x.io"], [EDITOR, "e@x.io"], [APPROVER, "a@x.io"], [VIEWER, "v@x.io"], [OUTSIDER, "x@x.io"]] as const) {
    await createUser(db, id, email);
  }
  org = (await as(db, OWNER, (tx) => q(tx, "insert into organizations (name, created_by) values ('Acme', $1) returning id", [OWNER])))[0]!.id as string;
  await as(db, OWNER, (tx) => q(tx, `insert into org_members (org_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'approver'), ($1, $4, 'viewer')`, [org, EDITOR, APPROVER, VIEWER]));
  wf = (await as(db, EDITOR, (tx) => q(tx, "insert into workflows (org_id, name, created_by) values ($1, 'Purchase', $2) returning id", [org, EDITOR])))[0]!.id as string;
  await saveDraft(db, EDITOR, wf, purchaseGraph());
});

describe("orgs and roles", () => {
  test("creator becomes owner; outsiders see nothing", async () => {
    expect(await as(db, OWNER, (tx) => q(tx, "select role from org_members where user_id = $1", [OWNER]))).toEqual([{ role: "owner" }]);
    expect(await as(db, OUTSIDER, (tx) => q(tx, "select * from organizations"))).toEqual([]);
    expect(await as(db, OUTSIDER, (tx) => q(tx, "select * from workflows"))).toEqual([]);
    expect(await as(db, OUTSIDER, (tx) => q(tx, "select * from profiles where id = $1", [OWNER]))).toEqual([]);
    expect(await as(db, VIEWER, (tx) => q(tx, "select email from profiles order by email"))).toHaveLength(4);
  });

  test("only admins manage members, only owners grant owner, last owner stays", async () => {
    expect((await failure(as(db, EDITOR, (tx) => q(tx, "insert into org_members values ($1, $2, 'viewer')", [org, OUTSIDER])))).code).toBe("42501");
    expect((await as(db, EDITOR, (tx) => q(tx, "update org_members set role = 'admin' where user_id = $1 returning 1", [EDITOR])))).toEqual([]);
    expect((await failure(as(db, OWNER, (tx) => q(tx, "delete from org_members where user_id = $1", [OWNER])))).message).toContain("at least one owner");
    expect((await failure(as(db, OWNER, (tx) => q(tx, "update org_members set role = 'admin' where user_id = $1", [OWNER])))).message).toContain("at least one owner");
  });

  test("viewers cannot write workflows; editors cannot move them between orgs", async () => {
    expect(await as(db, VIEWER, (tx) => q(tx, "update workflows set name = 'x' where id = $1 returning 1", [wf]))).toEqual([]);
    expect((await failure(as(db, VIEWER, (tx) => q(tx, "insert into workflows (org_id, name, created_by) values ($1, 'x', $2)", [org, VIEWER])))).code).toBe("42501");
    expect((await failure(as(db, EDITOR, (tx) => q(tx, "update workflows set org_id = gen_random_uuid() where id = $1", [wf])))).code).toBe("42501");
  });

  test("clients cannot write engine tables directly", async () => {
    for (const sql of [
      "update executions set status = 'succeeded'",
      "insert into audit_events (org_id, action, entity_type, entity_id) values (gen_random_uuid(), 'x', 'y', 'z')",
      "update approvals set status = 'approved'",
      "delete from execution_logs",
    ]) {
      expect((await failure(as(db, OWNER, (tx) => q(tx, sql)))).code).toBe("42501");
    }
  });
});

describe("publish and versions", () => {
  test("invalid drafts are not published; valid ones get numbered immutable versions", async () => {
    const draft = (await saveDraft(db, EDITOR, wf, { nodes: [n("s", "start")], edges: [] }), await publish(db, EDITOR, wf));
    expect(draft.ok).toBe(false);
    await saveDraft(db, EDITOR, wf, purchaseGraph());
    expect((await failure(publish(db, VIEWER, wf))).status).toBe(403);
    const v1 = await publish(db, EDITOR, wf);
    const v2 = await publish(db, EDITOR, wf);
    expect([v1.ok && v1.version, v2.ok && v2.version]).toEqual([1, 2]);
    const rows = await as(db, VIEWER, (tx) => q(tx, "select published_version_id from workflows where id = $1", [wf]));
    expect(rows[0]!.published_version_id).toBe(v2.ok && v2.id);
    expect((await failure(asOwnerDb("update workflow_versions set graph = '{}' where workflow_id = $1", [wf]))).message).toContain("immutable");
    expect((await failure(saveDraft(db, VIEWER, wf, purchaseGraph()))).status).toBe(404);
  });
});

describe("execution end to end", () => {
  test("false branch runs straight through and is persisted", async () => {
    const { id } = await startExecution(db, EDITOR, wf, { amount: 10 });
    const ex = await as(db, VIEWER, (tx) => q(tx, "select status, vars, finished_at from executions where id = $1", [id]));
    expect(ex[0]).toMatchObject({ status: "succeeded", vars: { approved_by: "policy" } });
    const steps = await as(db, VIEWER, (tx) => q(tx, "select node_id, status from execution_steps where execution_id = $1 order by seq", [id]));
    expect(steps.map((s) => s.node_id)).toEqual(["start", "check", "auto", "notify", "done"]);
    const logs = await as(db, VIEWER, (tx) => q(tx, "select message from execution_logs where execution_id = $1 order by id", [id]));
    expect(logs.at(-1)!.message).toBe("Execution succeeded");
  });

  test("approval flow: inbox, permissions, approve once", async () => {
    const { id } = await startExecution(db, EDITOR, wf, { amount: 5000 });
    const [ap] = await as(db, APPROVER, (tx) => q(tx, "select id, title, status from approvals where execution_id = $1", [id]));
    expect(ap).toMatchObject({ title: "Manager approval", status: "pending" });
    expect((await failure(decideApproval(db, VIEWER, ap!.id as string, "approved"))).status).toBe(403);
    expect((await failure(decideApproval(db, EDITOR, ap!.id as string, "approved"))).status).toBe(403);
    expect((await failure(decideApproval(db, OUTSIDER, ap!.id as string, "approved"))).status).toBe(404);
    await decideApproval(db, APPROVER, ap!.id as string, "approved", "fine");
    expect((await failure(decideApproval(db, OWNER, ap!.id as string, "rejected"))).status).toBe(409);
    const [row] = await as(db, VIEWER, (tx) => q(tx, "select e.status, a.status as ap, a.decided_by, a.comment from executions e join approvals a on a.execution_id = e.id where e.id = $1", [id]));
    expect(row).toEqual({ status: "succeeded", ap: "approved", decided_by: APPROVER, comment: "fine" });
    const audit = await as(db, OWNER, (tx) => q(tx, "select action, actor_id from audit_events where entity_id in ($1, $2) order by id", [id, ap!.id]));
    expect(audit).toEqual([{ action: "execution.started", actor_id: EDITOR }, { action: "approval.approved", actor_id: APPROVER }]);
    expect(await as(db, EDITOR, (tx) => q(tx, "select * from audit_events"))).toEqual([]); // admins only
  });

  test("rejection follows the rejected branch", async () => {
    const { id } = await startExecution(db, EDITOR, wf, { amount: 5000 });
    const [ap] = await as(db, APPROVER, (tx) => q(tx, "select id from approvals where execution_id = $1", [id]));
    await decideApproval(db, OWNER, ap!.id as string, "rejected");
    const [ex] = await asOwnerDb("select status from executions where id = $1", [id]);
    expect(ex!.status).toBe("failed");
  });

  test("cancel marks pending approvals cancelled", async () => {
    const { id } = await startExecution(db, EDITOR, wf, { amount: 5000 });
    expect((await failure(cancelExecution(db, APPROVER, id))).status).toBe(403);
    await cancelExecution(db, EDITOR, id);
    const [row] = await asOwnerDb("select e.status, a.status as ap from executions e join approvals a on a.execution_id = e.id where e.id = $1", [id]);
    expect(row).toEqual({ status: "cancelled", ap: "cancelled" });
    expect((await failure(cancelExecution(db, EDITOR, id))).status).toBe(409);
  });

  test("idempotency key returns the same execution", async () => {
    const a = await startExecution(db, EDITOR, wf, { amount: 1 }, "order-42");
    const b = await startExecution(db, EDITOR, wf, { amount: 1 }, "order-42");
    expect(b).toEqual({ id: a.id, created: false });
    expect((await failure(startExecution(db, VIEWER, wf, {}))).status).toBe(403);
    expect((await failure(startExecution(db, EDITOR, wf, [1, 2]))).message).toContain("JSON object");
  });

  test("unpublished workflows cannot run", async () => {
    const [w] = await as(db, EDITOR, (tx) => q(tx, "insert into workflows (org_id, name, created_by) values ($1, 'Draft only', $2) returning id", [org, EDITOR]));
    expect((await failure(startExecution(db, EDITOR, w!.id as string, {}))).status).toBe(409);
  });

  test("retries persist and resume via the worker or a manual resume", async () => {
    const [w] = await as(db, EDITOR, (tx) => q(tx, "insert into workflows (org_id, name, created_by) values ($1, 'Flaky', $2) returning id", [org, EDITOR]));
    const flakyId = w!.id as string;
    await saveDraft(db, EDITOR, flakyId, {
      nodes: [n("s", "start"), n("f", "action", { action: "simulated_flaky", failTimes: 2, maxAttempts: 3, backoffMs: 1000 }), n("z", "end")],
      edges: [e("s", "f"), e("f", "z")],
    });
    await publish(db, EDITOR, flakyId);
    const t0 = new Date("2030-01-01T00:00:00Z");
    const at = (ms: number) => ({ now: () => new Date(t0.getTime() + ms) });
    const { id } = await startExecution(db, EDITOR, flakyId, {}, null, at(0));
    const state = () => asOwnerDb("select e.status, s.attempt, s.status as step from executions e join execution_steps s on s.execution_id = e.id and s.node_id = 'f' where e.id = $1", [id]);
    expect((await state())[0]).toEqual({ status: "running", attempt: 1, step: "pending" });
    expect(await processDue(db, 10, at(500))).toBe(0); // not due yet
    expect(await processDue(db, 10, at(1000))).toBe(1);
    expect((await state())[0]).toEqual({ status: "running", attempt: 2, step: "pending" });
    await resumeExecution(db, EDITOR, id, at(3000));
    expect((await state())[0]).toEqual({ status: "succeeded", attempt: 3, step: "succeeded" });
    const warns = await asOwnerDb("select count(*)::int as c from execution_logs where execution_id = $1 and level = 'warn'", [id]);
    expect(warns[0]!.c).toBe(2);
  });

  test("deleting an org cascades without tripping the owner guard", async () => {
    const [o2] = await as(db, OUTSIDER, (tx) => q(tx, "insert into organizations (name, created_by) values ('Tmp', $1) returning id", [OUTSIDER]));
    await as(db, OUTSIDER, (tx) => q(tx, "delete from organizations where id = $1", [o2!.id]));
    expect(await asOwnerDb("select * from org_members where org_id = $1", [o2!.id])).toEqual([]);
  });
});
