import { addMember, changeRole, removeMember } from "@/app/actions";
import { InlineForm } from "@/components/forms";
import { btnDanger, btnSecondary, card, input, label, PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { can, getOrg, listMembers, ROLES } from "@/server/queries";

const ROLE_HELP = "Owner/admin: manage members · editor: build, publish, run · approver: decide approvals · viewer: read only";

export default async function MembersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const [org, members] = await Promise.all([getOrg(user.id, orgId), listMembers(user.id, orgId)]);
  const admin = org ? can.admin(org.role) : false;
  return (
    <>
      <PageHeader title="Members" />
      <p className="mb-4 text-xs text-slate-500">{ROLE_HELP}</p>
      {admin && (
        <div className={`${card} mb-6 p-4`}>
          <InlineForm action={addMember.bind(null, orgId)} submit="Add member">
            <div className="min-w-48 flex-1">
              <label htmlFor="m-email" className={label}>Email of an existing account</label>
              <input id="m-email" name="email" type="email" required className={input} />
            </div>
            <div>
              <label htmlFor="m-role" className={label}>Role</label>
              <select id="m-role" name="role" defaultValue="viewer" className={input}>
                {ROLES.map((r) => <option key={r}>{r}</option>)}
              </select>
            </div>
          </InlineForm>
        </div>
      )}
      <ul className={`${card} divide-y divide-slate-100 text-sm`}>
        {members.map((m) => (
          <li key={m.user_id} className="flex flex-wrap items-center gap-3 p-3">
            <span className="font-medium">{m.display_name}</span>
            <span className="text-slate-500">{m.email}</span>
            {admin && m.user_id !== user.id ? (
              <div className="ml-auto flex gap-2">
                <form action={changeRole.bind(null, orgId, m.user_id)} className="flex gap-2">
                  <select name="role" defaultValue={m.role} aria-label={`Role for ${m.email}`} className={input}>
                    {ROLES.map((r) => <option key={r}>{r}</option>)}
                  </select>
                  <button className={btnSecondary}>Save</button>
                </form>
                <form action={removeMember.bind(null, orgId, m.user_id)}><button className={btnDanger}>Remove</button></form>
              </div>
            ) : <span className="ml-auto text-slate-600">{m.role}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}
