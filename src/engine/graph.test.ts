import { describe, expect, test } from "vitest";
import { validateGraph, type Graph } from "./graph";
import { e, n, purchaseGraph } from "./fixtures";

const msgs = (g: unknown) => validateGraph(g).map((i) => i.message).join("\n");

describe("validateGraph", () => {
  test("accepts the purchase workflow", () => {
    expect(validateGraph(purchaseGraph())).toEqual([]);
  });

  test("rejects malformed input", () => {
    expect(validateGraph({ nodes: "x" }).length).toBeGreaterThan(0);
  });

  test("needs one start and an end", () => {
    expect(msgs({ nodes: [], edges: [] })).toMatch(/exactly one Start.*\n.*End/);
    expect(msgs({ nodes: [n("a", "start"), n("b", "start"), n("z", "end")], edges: [e("a", "z"), e("b", "z")] })).toContain("found 2");
  });

  test("condition needs both branches and a valid expression", () => {
    const g = purchaseGraph();
    g.edges = g.edges.filter((x) => x.sourceHandle !== "false");
    expect(msgs(g)).toContain('one "true" and one "false"');
    const g2 = purchaseGraph();
    g2.nodes[1]!.data.expression = "amount >";
    expect(msgs(g2)).toContain("end of expression");
  });

  test("approval needs an approved branch; rejected is optional", () => {
    const g = purchaseGraph();
    g.edges = g.edges.filter((x) => x.sourceHandle !== "rejected");
    g.nodes = g.nodes.filter((x) => x.id !== "denied");
    expect(validateGraph(g)).toEqual([]);
    g.edges = g.edges.filter((x) => x.sourceHandle !== "approved");
    expect(msgs(g)).toContain('one "approved"');
  });

  test("flags unreachable nodes, loops, dangling and self edges", () => {
    const g: Graph = {
      nodes: [n("s", "start"), n("a", "action", { action: "log", message: "hi" }), n("b", "action", { action: "log", message: "x" }), n("z", "end"), n("orphan", "end")],
      edges: [e("s", "a"), e("a", "b"), e("b", "a"), e("z", "ghost")],
    };
    const m = msgs(g);
    expect(m).toContain("not reachable");
    expect(m).toContain("loop");
    expect(m).toContain("missing node");
    expect(m).toContain("End \"z\" cannot have outgoing");
    expect(msgs({ nodes: [n("s", "start"), n("z", "end")], edges: [e("s", "s"), e("s", "z")] })).toContain("itself");
  });

  test("validates node config", () => {
    const g = purchaseGraph();
    g.nodes[3]!.data = { label: "", action: "set_variable", key: "1bad", value: "" };
    const m = msgs(g);
    expect(m).toContain("Label is required");
    const g2 = purchaseGraph();
    g2.nodes[3]!.data.key = "1bad";
    expect(msgs(g2)).toContain("variable name is invalid");
    const g3 = purchaseGraph();
    g3.nodes[3]!.data.maxAttempts = 50;
    expect(msgs(g3)).toContain("maxAttempts");
  });
});
