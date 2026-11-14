"use client";

import {
  addEdge, Background, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useContext, useMemo, useState, useTransition } from "react";
import { publishAction, runWorkflowAction, saveDraftAction } from "@/app/actions";
import { ACTION_KINDS, validateGraph, type Graph, type NodeType } from "@/engine/graph";
import { RunForm } from "./forms";
import { btnPrimary, btnSecondary, card, fmt, input, label } from "./ui";

type FlowNode = Node<Record<string, unknown>, NodeType>;

const COLORS: Record<NodeType, string> = {
  start: "border-emerald-400 bg-emerald-50",
  approval: "border-amber-400 bg-amber-50",
  condition: "border-sky-400 bg-sky-50",
  action: "border-violet-400 bg-violet-50",
  end: "border-slate-400 bg-slate-100",
};
const DEFAULTS: Record<NodeType, Record<string, unknown>> = {
  start: { label: "Start" },
  approval: { label: "Approval", instructions: "" },
  condition: { label: "Condition", expression: "input.amount > 100" },
  action: { label: "Action", action: "log", key: "", value: "", message: "Hello", failTimes: 0, maxAttempts: 3, backoffMs: 500 },
  end: { label: "End", outcome: "succeeded" },
};
const SOURCE_HANDLES: Record<NodeType, { id: string | null; text?: string }[]> = {
  start: [{ id: null }],
  action: [{ id: null }],
  condition: [{ id: "true", text: "true" }, { id: "false", text: "false" }],
  approval: [{ id: "approved", text: "approved" }, { id: "rejected", text: "rejected" }],
  end: [],
};

const IssueContext = createContext<Set<string>>(new Set());

function FlowNodeView({ id, type, data, selected }: NodeProps<FlowNode>) {
  const invalid = useContext(IssueContext).has(id);
  const handles = SOURCE_HANDLES[type];
  return (
    <div data-testid={`node-${id}`} className={`min-w-36 rounded-lg border-2 px-3 py-2 text-xs shadow-sm ${COLORS[type]} ${selected ? "ring-2 ring-indigo-500" : ""} ${invalid ? "outline-2 outline-dashed outline-red-500" : ""}`}>
      {type !== "start" && <Handle type="target" position={Position.Top} />}
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{type}</div>
      <div className="font-medium text-slate-900">{String(data.label ?? "")}</div>
      {type === "condition" && <div className="mt-1 font-mono text-[10px] text-slate-600">{String(data.expression ?? "")}</div>}
      {type === "action" && <div className="mt-1 text-[10px] text-slate-600">{String(data.action)}</div>}
      {handles.map((h, i) => (
        <Handle key={h.id ?? "out"} id={h.id ?? undefined} type="source" position={Position.Bottom}
          style={handles.length > 1 ? { left: `${((i + 1) / (handles.length + 1)) * 100}%` } : undefined}>
          {h.text && <span className="pointer-events-none absolute top-2 -translate-x-1/2 text-[9px] text-slate-600">{h.text}</span>}
        </Handle>
      ))}
    </div>
  );
}
const nodeTypes = Object.fromEntries((Object.keys(COLORS) as NodeType[]).map((t) => [t, FlowNodeView]));

const toFlow = (g: Graph) => ({
  nodes: g.nodes.map((n) => ({ ...n })) as FlowNode[],
  edges: g.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? null, label: e.sourceHandle ?? undefined })) as Edge[],
});
const toGraph = (nodes: FlowNode[], edges: Edge[]): Graph => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.type as NodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: (e.sourceHandle ?? null) as Graph["edges"][number]["sourceHandle"] })),
});

interface Props {
  orgId: string;
  workflowId: string;
  name: string;
  initialGraph: Graph;
  canEdit: boolean;
  canRun: boolean;
  publishedVersion: number | null;
  versions: { version: number; publishedAt: string; publishedBy: string | null }[];
}

export function Editor({ orgId, workflowId, name, initialGraph, canEdit, canRun, publishedVersion, versions }: Props) {
  const initial = useMemo(() => toFlow(initialGraph), [initialGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const issues = useMemo(() => validateGraph(graph), [graph]);
  const issueNodes = useMemo(() => new Set(issues.flatMap((i) => (i.nodeId ? [i.nodeId] : []))), [issues]);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const touch = () => { setDirty(true); setMessage(null); };

  function addNode(type: NodeType) {
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
    const y = Math.max(0, ...nodes.map((n) => n.position.y)) + 120;
    setNodes((ns) => [...ns, { id, type, position: { x: 0, y }, data: { ...DEFAULTS[type] } }]);
    setSelectedId(id);
    touch();
  }

  function updateSelected(patch: Record<string, unknown>) {
    if (!selectedId) return;
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)));
    touch();
  }

  function deleteSelected() {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
    touch();
  }

  function onConnect(c: Connection) {
    setEdges((es) =>
      addEdge({ ...c, id: `${c.source}-${c.sourceHandle ?? "out"}-${c.target}`, label: c.sourceHandle ?? undefined },
        // A source handle feeds exactly one edge: replace any existing one.
        es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)))),
    );
    touch();
  }

  function save() {
    startTransition(async () => {
      const r = await saveDraftAction(workflowId, graph);
      if (r.error) setMessage({ kind: "error", text: r.error });
      else { setDirty(false); setMessage({ kind: "ok", text: "Draft saved" }); }
    });
  }

  function publishNow() {
    startTransition(async () => {
      const r = await publishAction(orgId, workflowId, graph);
      if (r.error) setMessage({ kind: "error", text: r.error });
      else if (r.issues) setMessage({ kind: "error", text: `Not published: ${r.issues.length} validation issue(s)` });
      else { setDirty(false); setMessage({ kind: "ok", text: `Published version ${r.version}` }); }
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-xl font-semibold">{name}</h1>
          <span className="text-sm text-slate-500" data-testid="publish-state">
            {publishedVersion ? `Published v${publishedVersion}` : "Not published"}{dirty ? " · unsaved changes" : ""}
          </span>
          {canEdit && (
            <div className="ml-auto flex gap-2">
              <button className={btnSecondary} onClick={save} disabled={pending}>Save draft</button>
              <button className={btnPrimary} onClick={publishNow} disabled={pending || issues.length > 0}>Publish</button>
            </div>
          )}
        </div>
        {message && <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-red-700" : "text-emerald-700"}`}>{message.text}</p>}
        {canEdit && (
          <div className="flex flex-wrap gap-2" aria-label="Node library">
            {(["approval", "condition", "action", "end", "start"] as NodeType[]).map((t) => (
              <button key={t} className={`${btnSecondary} capitalize`} onClick={() => addNode(t)}>+ {t}</button>
            ))}
          </div>
        )}
        <div className={`${card} h-[560px]`}>
          <IssueContext.Provider value={issueNodes}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type !== "select" && x.type !== "dimensions")) touch(); }}
              onEdgesChange={(c) => { onEdgesChange(c); if (c.some((x) => x.type === "remove")) touch(); }}
              onConnect={onConnect}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              nodesDraggable={canEdit}
              nodesConnectable={canEdit}
              elementsSelectable
              deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
              fitView
            >
              <Background />
              <Controls />
            </ReactFlow>
          </IssueContext.Provider>
        </div>
        <section aria-label="Validation" className={`${card} p-3 text-sm`}>
          {issues.length === 0 ? <p className="text-emerald-700" data-testid="valid">Workflow is valid.</p> : (
            <ul className="list-disc space-y-1 pl-5 text-red-700" data-testid="issues">
              {issues.map((i, k) => (
                <li key={k}>
                  {i.nodeId ? <button className="underline" onClick={() => setSelectedId(i.nodeId!)}>{String(nodes.find((n) => n.id === i.nodeId)?.data.label ?? i.nodeId)}</button> : null}
                  {i.nodeId ? ": " : ""}{i.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className="space-y-4">
        <section className={`${card} p-4`} aria-label="Node configuration">
          <h2 className="mb-3 font-medium">{selected ? `Configure ${selected.type}` : "Configuration"}</h2>
          {!selected ? <p className="text-sm text-slate-500">Select a node to edit it. Drag from a node&apos;s bottom handle to another node to connect them.</p> : (
            <NodeConfig node={selected} disabled={!canEdit} onChange={updateSelected} onDelete={deleteSelected} />
          )}
        </section>
        {canRun && (
          <section className={`${card} p-4`}>
            <h2 className="mb-3 font-medium">Run</h2>
            {publishedVersion ? <RunForm action={runWorkflowAction.bind(null, orgId, workflowId)} />
              : <p className="text-sm text-slate-500">Publish a valid version to run it.</p>}
          </section>
        )}
        <section className={`${card} p-4`}>
          <h2 className="mb-2 font-medium">Versions</h2>
          {versions.length === 0 ? <p className="text-sm text-slate-500">Draft only.</p> : (
            <ul className="space-y-1 text-sm" data-testid="versions">
              {versions.map((v) => (
                <li key={v.version} className="flex justify-between gap-2">
                  <span>v{v.version}{v.version === publishedVersion ? " (live)" : ""}</span>
                  <span className="text-xs text-slate-500">{fmt(v.publishedAt)}{v.publishedBy ? ` · ${v.publishedBy}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">Published versions are immutable; runs always use the version that was live when they started.</p>
        </section>
      </aside>
    </div>
  );
}

function NodeConfig({ node, disabled, onChange, onDelete }: { node: FlowNode; disabled: boolean; onChange: (p: Record<string, unknown>) => void; onDelete: () => void }) {
  const d = node.data;
  const text = (key: string, title: string, opts: { mono?: boolean; area?: boolean; placeholder?: string } = {}) => (
    <div>
      <label htmlFor={`cfg-${key}`} className={label}>{title}</label>
      {opts.area ? (
        <textarea id={`cfg-${key}`} rows={3} disabled={disabled} value={String(d[key] ?? "")} placeholder={opts.placeholder}
          onChange={(e) => onChange({ [key]: e.target.value })} className={`${input} ${opts.mono ? "font-mono text-xs" : ""}`} />
      ) : (
        <input id={`cfg-${key}`} disabled={disabled} value={String(d[key] ?? "")} placeholder={opts.placeholder}
          onChange={(e) => onChange({ [key]: e.target.value })} className={`${input} ${opts.mono ? "font-mono text-xs" : ""}`} />
      )}
    </div>
  );
  const num = (key: string, title: string, min: number, max: number) => (
    <div>
      <label htmlFor={`cfg-${key}`} className={label}>{title}</label>
      <input id={`cfg-${key}`} type="number" min={min} max={max} disabled={disabled} value={Number(d[key] ?? 0)}
        onChange={(e) => onChange({ [key]: e.target.valueAsNumber || 0 })} className={input} />
    </div>
  );
  return (
    <div className="space-y-3 text-sm">
      {text("label", "Label")}
      {node.type === "condition" && (
        <>
          {text("expression", "Expression", { mono: true, area: true, placeholder: "input.amount > 1000 && input.region == 'EU'" })}
          <p className="text-xs text-slate-500">Use <code>input.*</code> and <code>vars.*</code> with == != &lt; &lt;= &gt; &gt;= &amp;&amp; || ! + - * / %. No function calls.</p>
        </>
      )}
      {node.type === "approval" && text("instructions", "Instructions for approvers", { area: true })}
      {node.type === "end" && (
        <div>
          <label htmlFor="cfg-outcome" className={label}>Outcome</label>
          <select id="cfg-outcome" disabled={disabled} value={String(d.outcome)} onChange={(e) => onChange({ outcome: e.target.value })} className={input}>
            <option value="succeeded">succeeded</option><option value="failed">failed</option>
          </select>
        </div>
      )}
      {node.type === "action" && (
        <>
          <div>
            <label htmlFor="cfg-action" className={label}>Action</label>
            <select id="cfg-action" disabled={disabled} value={String(d.action)} onChange={(e) => onChange({ action: e.target.value })} className={input}>
              {ACTION_KINDS.map((k) => <option key={k} value={k}>{k === "simulated_flaky" ? "simulated_flaky (demo of retries)" : k}</option>)}
            </select>
          </div>
          {d.action === "set_variable" && <>{text("key", "Variable name", { mono: true })}{text("value", "Value expression", { mono: true, placeholder: "input.amount * 2" })}</>}
          {d.action === "log" && text("message", "Message")}
          {d.action === "simulated_flaky" && num("failTimes", "Fail the first N attempts", 0, 10)}
          <div className="grid grid-cols-2 gap-2">
            {num("maxAttempts", "Max attempts (1–5)", 1, 5)}
            {num("backoffMs", "Backoff ms", 0, 60000)}
          </div>
        </>
      )}
      {!disabled && <button className={`${btnSecondary} w-full text-red-700`} onClick={onDelete}>Delete node</button>}
    </div>
  );
}
