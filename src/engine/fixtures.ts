import type { Graph, GraphEdge, GraphNode, NodeType } from "./graph";

/** Builds graphs tersely for tests and seed data. */
export function n(id: string, type: NodeType, data: Record<string, unknown> = {}, x = 0, y = 0): GraphNode {
  return { id, type, position: { x, y }, data: { label: id, ...data } };
}
export function e(source: string, target: string, sourceHandle: GraphEdge["sourceHandle"] = null): GraphEdge {
  return { id: `${source}-${sourceHandle ?? "out"}-${target}`, source, target, sourceHandle };
}

/** Purchase approval: amounts over 1000 need manager approval. */
export function purchaseGraph(): Graph {
  return {
    nodes: [
      n("start", "start", { label: "Request received" }, 0, 0),
      n("check", "condition", { label: "Over 1000?", expression: "input.amount > 1000" }, 0, 120),
      n("approve", "approval", { label: "Manager approval", instructions: "Check the budget" }, -200, 240),
      n("auto", "action", { label: "Auto-approve", action: "set_variable", key: "approved_by", value: "'policy'" }, 200, 240),
      n("notify", "action", { label: "Record", action: "log", message: "Purchase approved" }, 0, 360),
      n("done", "end", { label: "Done" }, 0, 480),
      n("denied", "end", { label: "Denied", outcome: "failed" }, -400, 360),
    ],
    edges: [
      e("start", "check"),
      e("check", "approve", "true"),
      e("check", "auto", "false"),
      e("approve", "notify", "approved"),
      e("approve", "denied", "rejected"),
      e("auto", "notify"),
      e("notify", "done"),
    ],
  };
}
