import { z } from "zod";
import { ExpressionError, parseExpression } from "./expression";

export const NODE_TYPES = ["start", "approval", "condition", "action", "end"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const ACTION_KINDS = ["set_variable", "log", "simulated_flaky"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const label = z.string().trim().min(1, "Label is required").max(80);
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/, "Use letters, digits and _ (max 40)");

export const nodeDataSchemas = {
  start: z.object({ label }),
  approval: z.object({ label, instructions: z.string().max(500).default("") }),
  condition: z.object({ label, expression: z.string().max(500) }),
  action: z.object({
    label,
    action: z.enum(ACTION_KINDS),
    key: z.string().max(40).default(""),
    value: z.string().max(500).default(""),
    message: z.string().max(500).default(""),
    failTimes: z.number().int().min(0).max(10).default(0),
    maxAttempts: z.number().int().min(1).max(5).default(3),
    backoffMs: z.number().int().min(0).max(60_000).default(500),
  }),
  end: z.object({ label, outcome: z.enum(["succeeded", "failed"]).default("succeeded") }),
} satisfies Record<NodeType, z.ZodType>;

export type NodeData<T extends NodeType = NodeType> = z.output<(typeof nodeDataSchemas)[T]>;

export const HANDLES = ["true", "false", "approved", "rejected"] as const;
export type Handle = (typeof HANDLES)[number];

export const graphSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        type: z.enum(NODE_TYPES),
        position: z.object({ x: z.number(), y: z.number() }),
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .max(200),
  edges: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        source: z.string(),
        target: z.string(),
        sourceHandle: z.enum(HANDLES).nullable().optional(),
      }),
    )
    .max(400),
});

export type Graph = z.infer<typeof graphSchema>;
export type GraphNode = Graph["nodes"][number];
export type GraphEdge = Graph["edges"][number];

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

export function nodeData<T extends NodeType>(node: GraphNode & { type: T }): NodeData<T> {
  return nodeDataSchemas[node.type].parse(node.data) as NodeData<T>;
}

/** Outgoing edge for a node, optionally restricted to one handle. */
export function outgoing(graph: Graph, nodeId: string, handle?: Handle | null): GraphEdge[] {
  return graph.edges.filter((e) => e.source === nodeId && (handle === undefined || (e.sourceHandle ?? null) === handle));
}

/**
 * Structural + configuration validation. A graph must pass this before it can
 * be published, and the engine only ever runs published graphs.
 */
export function validateGraph(input: unknown): ValidationIssue[] {
  const parsed = graphSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ message: `${i.path.join(".")}: ${i.message}` }));
  const graph = parsed.data;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) issues.push({ nodeId: n.id, message: "Duplicate node id" });
    ids.add(n.id);
  }

  const starts = graph.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) issues.push({ message: `Workflow needs exactly one Start node (found ${starts.length})` });
  if (!graph.nodes.some((n) => n.type === "end")) issues.push({ message: "Workflow needs at least one End node" });

  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) issues.push({ message: `Edge ${e.id} points to a missing node` });
    if (e.source === e.target) issues.push({ nodeId: e.source, message: "A node cannot connect to itself" });
  }

  for (const n of graph.nodes) {
    const data = nodeDataSchemas[n.type].safeParse(n.data);
    if (!data.success) {
      for (const i of data.error.issues) issues.push({ nodeId: n.id, message: `${i.path.join(".") || "config"}: ${i.message}` });
      continue;
    }
    const out = outgoing(graph, n.id);
    const incoming = graph.edges.filter((e) => e.target === n.id);
    const name = `"${(data.data as { label: string }).label}"`;
    const handles = out.map((e) => e.sourceHandle ?? null);

    switch (n.type) {
      case "start":
        if (incoming.length) issues.push({ nodeId: n.id, message: "Start cannot have incoming connections" });
        if (out.length !== 1 || handles[0] !== null) issues.push({ nodeId: n.id, message: "Start needs exactly one outgoing connection" });
        break;
      case "end":
        if (out.length) issues.push({ nodeId: n.id, message: `End ${name} cannot have outgoing connections` });
        break;
      case "action":
        if (out.length !== 1 || handles[0] !== null) issues.push({ nodeId: n.id, message: `Action ${name} needs exactly one outgoing connection` });
        {
          const d = data.data as NodeData<"action">;
          if (d.action === "set_variable") {
            if (!identifier.safeParse(d.key).success) issues.push({ nodeId: n.id, message: `Action ${name}: variable name is invalid` });
            checkExpr(d.value, n.id, name, issues);
          }
          if (d.action === "log" && !d.message.trim()) issues.push({ nodeId: n.id, message: `Action ${name}: message is required` });
        }
        break;
      case "condition": {
        const t = handles.filter((h) => h === "true").length;
        const f = handles.filter((h) => h === "false").length;
        if (t !== 1 || f !== 1 || out.length !== 2) issues.push({ nodeId: n.id, message: `Condition ${name} needs one "true" and one "false" connection` });
        checkExpr((data.data as NodeData<"condition">).expression, n.id, name, issues);
        break;
      }
      case "approval": {
        const a = handles.filter((h) => h === "approved").length;
        const r = handles.filter((h) => h === "rejected").length;
        if (a !== 1 || r > 1 || out.length !== a + r) issues.push({ nodeId: n.id, message: `Approval ${name} needs one "approved" connection and at most one "rejected" connection` });
        break;
      }
    }
  }

  if (starts.length === 1) {
    const reachable = new Set<string>();
    const stack = [starts[0]!.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of outgoing(graph, id)) stack.push(e.target);
    }
    for (const n of graph.nodes) if (!reachable.has(n.id)) issues.push({ nodeId: n.id, message: "Node is not reachable from Start" });
    if (hasCycle(graph)) issues.push({ message: "Workflow contains a loop; only acyclic workflows are supported" });
  }
  return issues;
}

function checkExpr(src: string, nodeId: string, name: string, issues: ValidationIssue[]) {
  try {
    parseExpression(src);
  } catch (e) {
    issues.push({ nodeId, message: `${name}: ${e instanceof ExpressionError ? e.message : "invalid expression"}` });
  }
}

function hasCycle(graph: Graph): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const e of outgoing(graph, id)) if (visit(e.target)) return true;
    state.set(id, 2);
    return false;
  };
  return graph.nodes.some((n) => visit(n.id));
}
