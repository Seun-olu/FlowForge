import Link from "next/link";
import { decideAction } from "@/app/actions";
import { DecisionForm } from "@/components/forms";
import { card, Empty, fmt, PageHeader, StatusBadge } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { can, getOrg, listApprovals } from "@/server/queries";

export default async function InboxPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const [org, pending, decided] = await Promise.all([
    getOrg(user.id, orgId), listApprovals(user.id, orgId, "pending"), listApprovals(user.id, orgId, "decided"),
  ]);
  const mayDecide = org ? can.approve(org.role) : false;
  return (
    <>
      <PageHeader title="Approval inbox" />
      {!mayDecide && <p className="mb-4 text-sm text-slate-600">Your role can view approvals but not decide them.</p>}
      {pending.length === 0 ? <Empty>Nothing waiting for approval.</Empty> : (
        <ul className="space-y-3" data-testid="pending-approvals">
          {pending.map((a) => (
            <li key={a.id} className={`${card} p-4`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.title}</span>
                <span className="text-sm text-slate-500">in {a.workflow_name}</span>
                <Link className="text-xs text-indigo-700 underline" href={`/o/${orgId}/executions/${a.execution_id}`}>run {a.execution_id.slice(0, 8)}</Link>
                <span className="ml-auto text-xs text-slate-400">{fmt(a.created_at)}</span>
              </div>
              {a.instructions && <p className="mb-2 text-sm text-slate-700">{a.instructions}</p>}
              <pre className="mb-3 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(a.input)}</pre>
              {mayDecide && <DecisionForm action={decideAction.bind(null, orgId, a.id)} />}
            </li>
          ))}
        </ul>
      )}
      <h2 className="mb-2 mt-8 font-medium">Recently decided</h2>
      {decided.length === 0 ? <Empty>No decisions yet.</Empty> : (
        <ul className={`${card} divide-y divide-slate-100 text-sm`}>
          {decided.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 p-3">
              <StatusBadge status={a.status} />
              <span>{a.title}</span><span className="text-slate-500">· {a.workflow_name}</span>
              <span className="text-slate-500">{a.decided_by ? `by ${a.decided_by}` : ""}{a.comment ? ` — “${a.comment}”` : ""}</span>
              <Link className="ml-auto text-xs text-indigo-700 underline" href={`/o/${orgId}/executions/${a.execution_id}`}>view run</Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
