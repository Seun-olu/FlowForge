import Link from "next/link";
import { createOrg, signOut } from "@/app/actions";
import { InlineForm } from "@/components/forms";
import { btnSecondary, card, Empty, input, label } from "@/components/ui";
import { requireUser } from "@/server/auth";
import { listOrgs } from "@/server/queries";

export default async function OrgsPage() {
  const user = await requireUser();
  const orgs = await listOrgs(user.id);
  return (
    <main className="mx-auto mt-16 max-w-xl space-y-6 px-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Organizations</h1>
        <form action={signOut}><button className={btnSecondary}>Sign out</button></form>
      </div>
      {orgs.length ? (
        <ul className={`${card} divide-y divide-slate-100`}>
          {orgs.map((o) => (
            <li key={o.id}>
              <Link href={`/o/${o.id}`} className="flex justify-between px-4 py-3 hover:bg-slate-50">
                <span className="font-medium">{o.name}</span><span className="text-sm text-slate-500">{o.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : <Empty>You aren&apos;t in any organization yet. Create one, or ask an admin to add {user.email}.</Empty>}
      <div className={`${card} p-4`}>
        <InlineForm action={createOrg} submit="Create organization">
          <div className="flex-1">
            <label htmlFor="org-name" className={label}>New organization name</label>
            <input id="org-name" name="name" required maxLength={80} className={input} />
          </div>
        </InlineForm>
      </div>
    </main>
  );
}
