import Link from "next/link";
import { createWorkflow } from "@/app/actions";
import { InlineForm } from "@/components/forms";
import { card, Empty, fmt, input, label, PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { can, getOrg, listWorkflows } from "@/server/queries";

export default async function WorkflowsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const [org, workflows] = await Promise.all([getOrg(user.id, orgId), listWorkflows(user.id, orgId)]);
  return (
    <>
      <PageHeader title="Workflows" />
      {org && can.edit(org.role) && (
        <div className={`${card} mb-6 p-4`}>
          <InlineForm action={createWorkflow.bind(null, orgId)} submit="Create workflow">
            <div className="min-w-48 flex-1">
              <label htmlFor="wf-name" className={label}>Name</label>
              <input id="wf-name" name="name" required maxLength={80} className={input} />
            </div>
            <div>
              <label htmlFor="wf-template" className={label}>Start from</label>
              <select id="wf-template" name="template" className={input}>
                <option value="blank">Blank (Start → End)</option>
                <option value="purchase">Sample: purchase approval</option>
              </select>
            </div>
          </InlineForm>
        </div>
      )}
      {workflows.length === 0 ? <Empty>No workflows yet.</Empty> : (
        <table className={`${card} w-full text-left text-sm`}>
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr><th className="p-3">Name</th><th className="p-3">Published</th><th className="p-3">Runs</th><th className="p-3">Updated</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {workflows.map((w) => (
              <tr key={w.id}>
                <td className="p-3"><Link className="font-medium text-indigo-700 hover:underline" href={`/o/${orgId}/workflows/${w.id}`}>{w.name}</Link></td>
                <td className="p-3">{w.published_version ? `v${w.published_version}` : <span className="text-slate-400">draft only</span>}</td>
                <td className="p-3">{w.runs}</td>
                <td className="p-3 text-slate-500">{fmt(w.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
