import Link from "next/link";
import { card, Empty, fmt, PageHeader, StatusBadge } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { listExecutions } from "@/server/queries";

const FILTERS = ["running", "waiting_approval", "succeeded", "failed", "rejected", "cancelled"];

export default async function ExecutionsPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ status?: string }> }) {
  const { orgId } = await params;
  const { status } = await searchParams;
  const user = await requireUser();
  const filter = status && FILTERS.includes(status) ? status : undefined;
  const runs = await listExecutions(user.id, orgId, filter);
  return (
    <>
      <PageHeader title="Execution history" />
      <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-2 text-sm">
        {[undefined, ...FILTERS].map((f) => (
          <Link key={f ?? "all"} href={f ? `?status=${f}` : "?"}
            className={`rounded-full px-3 py-1 ring-1 ring-slate-200 ${f === filter ? "bg-indigo-600 text-white" : "bg-white"}`}>
            {f ? f.replace("_", " ") : "all"}
          </Link>
        ))}
      </nav>
      {runs.length === 0 ? <Empty>No runs{filter ? " with this status" : " yet"}.</Empty> : (
        <table className={`${card} w-full text-left text-sm`}>
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr><th className="p-3">Run</th><th className="p-3">Workflow</th><th className="p-3">Status</th><th className="p-3">Started</th><th className="p-3">By</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="p-3"><Link className="font-mono text-xs text-indigo-700 hover:underline" href={`/o/${orgId}/executions/${r.id}`}>{r.id.slice(0, 8)}</Link></td>
                <td className="p-3">{r.workflow_name} <span className="text-slate-400">v{r.version}</span></td>
                <td className="p-3"><StatusBadge status={r.status} /></td>
                <td className="p-3 text-slate-500">{fmt(r.started_at)}</td>
                <td className="p-3 text-slate-500">{r.started_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
