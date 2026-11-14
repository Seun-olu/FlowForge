import Link from "next/link";
import { notFound } from "next/navigation";
import { signOut } from "@/app/actions";
import { requireUser } from "@/server/auth";
import { can, getOrg } from "@/server/queries";

export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const org = await getOrg(user.id, orgId);
  if (!org) notFound();
  const links = [
    ["Workflows", `/o/${orgId}`],
    ["Runs", `/o/${orgId}/executions`],
    [`Inbox${org.pending ? ` (${org.pending})` : ""}`, `/o/${orgId}/inbox`],
    ["Members", `/o/${orgId}/members`],
    ...(can.admin(org.role) ? [["Audit", `/o/${orgId}/audit`]] : []),
  ];
  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/orgs" className="font-semibold text-indigo-700">FlowForge</Link>
          <span className="text-sm text-slate-500">{org.name} · <span data-testid="role">{org.role}</span></span>
          <nav aria-label="Organization" className="flex flex-wrap gap-4 text-sm">
            {links.map(([text, href]) => <Link key={href} href={href} className="text-slate-700 hover:text-indigo-700">{text}</Link>)}
          </nav>
          <form action={signOut} className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-slate-500">{user.displayName}</span>
            <button className="text-slate-700 underline">Sign out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </>
  );
}
