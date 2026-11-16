import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { listOrgs } from "@/server/queries";

export default async function Home() {
  const user = await requireUser();
  const orgs = await listOrgs(user.id);
  redirect(orgs[0] ? `/o/${orgs[0].id}` : "/orgs");
}
