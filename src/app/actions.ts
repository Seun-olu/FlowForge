"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { e, n, purchaseGraph } from "@/engine/fixtures";
import type { ValidationIssue } from "@/engine/graph";
import { checkCredentials, clearSession, createAccount, requireUser, setSession } from "@/server/auth";
import { asOwner, getDb } from "@/server/db";
import { ROLES, withUser } from "@/server/queries";
import { cancelExecution, decideApproval, publish, resumeExecution, RunnerError, saveDraft, startExecution } from "@/server/runner";

export type FormState = { error?: string; ok?: string } | undefined;

const errMsg = (e: unknown) => {
  if (e instanceof RunnerError) return e.message;
  if (e && typeof e === "object" && "code" in e && e.code === "42501") return "You don't have permission to do that";
  console.error(e);
  return "Something went wrong";
};

// ---------- auth ----------
const credentials = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export async function signUp(_: FormState, form: FormData): Promise<FormState> {
  const parsed = credentials.extend({ name: z.string().trim().min(1, "Name is required").max(80) }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };
  const id = await createAccount(await getDb(), parsed.data.email, parsed.data.password, parsed.data.name);
  if (!id) return { error: "An account with that email already exists" };
  await setSession(id);
  redirect("/");
}

export async function signIn(_: FormState, form: FormData): Promise<FormState> {
  const parsed = credentials.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Email or password is incorrect" };
  const id = await checkCredentials(await getDb(), parsed.data.email, parsed.data.password);
  if (!id) return { error: "Email or password is incorrect" };
  await setSession(id);
  redirect("/");
}

export async function signOut() {
  await clearSession();
  redirect("/login");
}

// ---------- orgs & members ----------
export async function createOrg(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const name = z.string().trim().min(1, "Name is required").max(80).safeParse(form.get("name"));
  if (!name.success) return { error: name.error.issues[0]!.message };
  const id = await withUser(user.id, async (tx) =>
    (await tx.query<{ id: string }>("insert into organizations (name, created_by) values ($1, $2) returning id", [name.data, user.id])).rows[0]!.id);
  redirect(`/o/${id}`);
}

export async function addMember(orgId: string, _: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(ROLES) }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Enter an email and a role" };
  try {
    const result = await withUser(user.id, async (tx) => {
      const ok = (await tx.query<{ ok: boolean }>("select private.can_admin($1) as ok", [orgId])).rows[0]?.ok;
      if (!ok) return "You don't have permission to do that";
      // The new member isn't visible through RLS yet, so look them up as the owner role.
      await asOwner(tx);
      const target = (await tx.query<{ id: string }>("select id from public.profiles where lower(email) = $1", [parsed.data.email])).rows[0];
      if (!target) return "No FlowForge account uses that email yet";
      await tx.exec("set local role authenticated");
      const inserted = await tx.query(
        "insert into org_members (org_id, user_id, role) values ($1, $2, $3) on conflict do nothing returning user_id", [orgId, target.id, parsed.data.role]);
      return inserted.rows.length ? null : "That person is already a member";
    });
    if (result) return { error: result };
  } catch (e) {
    return { error: errMsg(e) };
  }
  revalidatePath(`/o/${orgId}/members`);
  return { ok: "Member added" };
}

export async function changeRole(orgId: string, userId: string, form: FormData) {
  const user = await requireUser();
  const role = z.enum(ROLES).parse(form.get("role"));
  await withUser(user.id, (tx) => tx.query("update org_members set role = $3 where org_id = $1 and user_id = $2", [orgId, userId, role])).catch(errMsg);
  revalidatePath(`/o/${orgId}/members`);
}

export async function removeMember(orgId: string, userId: string) {
  const user = await requireUser();
  await withUser(user.id, (tx) => tx.query("delete from org_members where org_id = $1 and user_id = $2", [orgId, userId])).catch(errMsg);
  revalidatePath(`/o/${orgId}/members`);
}

// ---------- workflows ----------
const starter = () => ({
  nodes: [n("start", "start", { label: "Start" }, 0, 0), n("end", "end", { label: "End", outcome: "succeeded" }, 0, 200)],
  edges: [e("start", "end")],
});

export async function createWorkflow(orgId: string, _: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = z.object({ name: z.string().trim().min(1, "Name is required").max(80), template: z.enum(["blank", "purchase"]) })
    .safeParse({ name: form.get("name"), template: form.get("template") ?? "blank" });
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };
  let id: string;
  try {
    id = await withUser(user.id, async (tx) =>
      (await tx.query<{ id: string }>(
        "insert into workflows (org_id, name, created_by, draft_graph) values ($1, $2, $3, $4) returning id",
        [orgId, parsed.data.name, user.id, JSON.stringify(parsed.data.template === "purchase" ? purchaseGraph() : starter())],
      )).rows[0]!.id);
  } catch (e) {
    return { error: errMsg(e) };
  }
  redirect(`/o/${orgId}/workflows/${id}`);
}

export async function saveDraftAction(workflowId: string, graph: unknown): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await saveDraft(await getDb(), user.id, workflowId, graph);
    return {};
  } catch (e) {
    return { error: errMsg(e) };
  }
}

export async function publishAction(orgId: string, workflowId: string, graph: unknown): Promise<{ error?: string; issues?: ValidationIssue[]; version?: number }> {
  const user = await requireUser();
  try {
    const db = await getDb();
    await saveDraft(db, user.id, workflowId, graph);
    const result = await publish(db, user.id, workflowId);
    revalidatePath(`/o/${orgId}/workflows/${workflowId}`);
    return result.ok ? { version: result.version } : { issues: result.issues };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/** Short scheduled retries (≤ 3s away) are waited out in the request so simple runs finish immediately. */
async function settle(uid: string, executionId: string) {
  const db = await getDb();
  for (let i = 0; i < 5; i++) {
    const row = await withUser(uid, async (tx) =>
      (await tx.query<{ status: string; next_run_at: Date | null }>("select status, next_run_at from executions where id = $1", [executionId])).rows[0]);
    if (!row || row.status !== "running" || !row.next_run_at) return;
    const wait = new Date(row.next_run_at).getTime() - Date.now();
    if (wait > 3000) return;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await resumeExecution(db, uid, executionId);
  }
}

export async function runWorkflowAction(orgId: string, workflowId: string, _: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  let input: unknown;
  try {
    input = JSON.parse(String(form.get("input") || "{}"));
  } catch {
    return { error: "Input must be valid JSON" };
  }
  const key = String(form.get("idempotencyKey") ?? "").trim() || null;
  let id: string;
  try {
    ({ id } = await startExecution(await getDb(), user.id, workflowId, input, key));
    await settle(user.id, id);
  } catch (e) {
    return { error: errMsg(e) };
  }
  redirect(`/o/${orgId}/executions/${id}`);
}

export async function decideAction(orgId: string, approvalId: string, _: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const decision = z.enum(["approved", "rejected"]).safeParse(form.get("decision"));
  if (!decision.success) return { error: "Choose approve or reject" };
  try {
    const { executionId } = await decideApproval(await getDb(), user.id, approvalId, decision.data, String(form.get("comment") ?? "").trim());
    await settle(user.id, executionId);
  } catch (e) {
    return { error: errMsg(e) };
  }
  revalidatePath(`/o/${orgId}`, "layout");
  return { ok: decision.data === "approved" ? "Approved" : "Rejected" };
}

export async function cancelAction(orgId: string, executionId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await cancelExecution(await getDb(), user.id, executionId);
  } catch (e) {
    return { error: errMsg(e) };
  }
  revalidatePath(`/o/${orgId}`, "layout");
}

export async function resumeAction(orgId: string, executionId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await resumeExecution(await getDb(), user.id, executionId);
    await settle(user.id, executionId);
  } catch (e) {
    return { error: errMsg(e) };
  }
  revalidatePath(`/o/${orgId}/executions/${executionId}`);
}
