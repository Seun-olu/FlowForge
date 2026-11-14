import { notFound } from "next/navigation";
import { card, Empty, fmt, PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { can, getOrg, listAudit } from "@/server/queries";

export default async function AuditPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const org = await getOrg(user.id, orgId);
  if (!org || !can.admin(org.role)) notFound();
  const events = await listAudit(user.id, orgId);
  return (
    <>
      <PageHeader title="Audit history" />
      {events.length === 0 ? <Empty>No events.</Empty> : (
        <table className={`${card} w-full text-left text-sm`}>
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr><th className="p-3">When</th><th className="p-3">Who</th><th className="p-3">Action</th><th className="p-3">Details</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {events.map((e) => (
              <tr key={e.id}>
                <td className="p-3 text-slate-500">{fmt(e.created_at)}</td>
                <td className="p-3">{e.actor ?? "system"}</td>
                <td className="p-3 font-mono text-xs">{e.action}</td>
                <td className="p-3 font-mono text-xs text-slate-600">{e.entity_type} {e.entity_id.slice(0, 8)} {JSON.stringify(e.data)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
