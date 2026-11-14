import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelAction, decideAction, resumeAction } from "@/app/actions";
import { ActionButton, DecisionForm } from "@/components/forms";
import { card, fmt, PageHeader, StatusBadge } from "@/components/ui";
import { graphSchema } from "@/engine/graph";
import { requireUser } from "@/server/auth";
import { can, getExecution, getOrg } from "@/server/queries";

export default async function ExecutionPage({ params }: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await params;
  const user = await requireUser();
  const [org, ex] = await Promise.all([getOrg(user.id, orgId), getExecution(user.id, id)]);
  if (!org || !ex || ex.org_id !== orgId) notFound();
  const graph = graphSchema.parse(ex.graph);
  const labelOf = (nodeId: string) => String(graph.nodes.find((n) => n.id === nodeId)?.data.label ?? nodeId);
  const active = ex.status === "running" || ex.status === "waiting_approval";
  return (
    <>
      <PageHeader title={`${ex.workflow_name} · run ${ex.id.slice(0, 8)}`}>
        <div className="flex items-center gap-2">
          <span data-testid="execution-status"><StatusBadge status={ex.status} /></span>
          {active && can.run(org.role) && ex.status === "running" && <ActionButton action={resumeAction.bind(null, orgId, id)}>Resume now</ActionButton>}
          {active && can.run(org.role) && <ActionButton danger action={cancelAction.bind(null, orgId, id)}>Cancel run</ActionButton>}
        </div>
      </PageHeader>
      <dl className="mb-6 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        {[
          ["Version", <Link key="v" className="text-indigo-700 underline" href={`/o/${orgId}/workflows/${ex.workflow_id}`}>v{ex.version}</Link>],
          ["Started", fmt(ex.started_at)],
          ["Finished", fmt(ex.finished_at)],
          ["Started by", ex.started_by],
          ...(ex.next_run_at ? [["Next retry", fmt(ex.next_run_at)]] : []),
          ...(ex.idempotency_key ? [["Idempotency key", ex.idempotency_key]] : []),
        ].map(([k, v]) => (
          <div key={String(k)} className={`${card} p-3`}><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-1">{v}</dd></div>
        ))}
      </dl>
      {ex.error && <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{ex.error}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="mb-2 font-medium">Steps</h2>
          <ol className={`${card} divide-y divide-slate-100`} data-testid="steps">
            {ex.steps.map((s) => {
              const approval = ex.approvals.find((a) => a.step_id === s.id);
              return (
                <li key={s.id} className="space-y-2 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-6 text-slate-400">{s.seq}.</span>
                    <span className="font-medium">{labelOf(s.node_id)}</span>
                    <span className="text-xs text-slate-500">{s.node_type}</span>
                    <StatusBadge status={s.status} />
                    {s.node_type === "action" && <span className="text-xs text-slate-500">attempt {s.attempt}/{s.max_attempts}</span>}
                  </div>
                  {s.error && <p className="ml-8 text-xs text-red-700">{s.error}</p>}
                  {s.output !== null && <pre className="ml-8 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(s.output)}</pre>}
                  {approval && approval.status === "pending" && can.approve(org.role) && (
                    <div className="ml-8"><DecisionForm action={decideAction.bind(null, orgId, approval.id)} /></div>
                  )}
                  {approval && approval.status !== "pending" && (
                    <p className="ml-8 text-xs text-slate-600">{approval.status} by {approval.decided_by ?? "—"} {approval.comment ? `— “${approval.comment}”` : ""}</p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
        <section className="space-y-4">
          <div>
            <h2 className="mb-2 font-medium">Input</h2>
            <pre className={`${card} overflow-x-auto p-3 text-xs`}>{JSON.stringify(ex.input, null, 2)}</pre>
          </div>
          <div>
            <h2 className="mb-2 font-medium">Variables</h2>
            <pre className={`${card} overflow-x-auto p-3 text-xs`}>{JSON.stringify(ex.vars, null, 2)}</pre>
          </div>
        </section>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 font-medium">Log</h2>
        <ol className={`${card} divide-y divide-slate-100 font-mono text-xs`} data-testid="logs">
          {ex.logs.map((l) => (
            <li key={l.id} className="flex gap-3 p-2">
              <span className="text-slate-400">{new Date(l.created_at).toLocaleTimeString("en-GB")}</span>
              <span className={l.level === "error" ? "text-red-700" : l.level === "warn" ? "text-amber-700" : "text-slate-500"}>{l.level}</span>
              <span>{l.message}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
