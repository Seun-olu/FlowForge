import { notFound } from "next/navigation";
import { Editor } from "@/components/editor";
import { graphSchema } from "@/engine/graph";
import { requireUser } from "@/server/auth";
import { can, getOrg, getWorkflow } from "@/server/queries";

export default async function WorkflowPage({ params }: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await params;
  const user = await requireUser();
  const [org, wf] = await Promise.all([getOrg(user.id, orgId), getWorkflow(user.id, id)]);
  if (!org || !wf || wf.org_id !== orgId) notFound();
  const draft = graphSchema.safeParse(wf.draft_graph);
  const published = wf.versions.find((v) => v.id === wf.published_version_id);
  return (
    <Editor
      orgId={orgId}
      workflowId={wf.id}
      name={wf.name}
      initialGraph={draft.success ? draft.data : { nodes: [], edges: [] }}
      canEdit={can.edit(org.role)}
      canRun={can.run(org.role)}
      publishedVersion={published?.version ?? null}
      versions={wf.versions.map((v) => ({ version: v.version, publishedAt: new Date(v.published_at).toISOString(), publishedBy: v.published_by }))}
    />
  );
}
