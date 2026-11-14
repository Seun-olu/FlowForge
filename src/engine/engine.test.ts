import { describe, expect, test } from "vitest";
import { advance, createExecution, EngineError, type ExecutionState } from "./engine";
import { e, n, purchaseGraph } from "./fixtures";
import type { Graph } from "./graph";

const T0 = new Date("2026-01-01T00:00:00Z");
function opts(now = T0) {
  let i = 0;
  return { now, newId: () => `id${++i}` };
}
// Stable ids across separate calls on one execution.
let counter = 0;
const o = (now = T0) => ({ now, newId: () => `s${++counter}` });
const path = (s: ExecutionState) => s.steps.map((x) => `${x.nodeId}:${x.status}`);

describe("engine: sequential + condition", () => {
  test("small amount takes the false branch and succeeds", () => {
    const { state, approvalsRequested, logs } = createExecution(purchaseGraph(), "x1", { amount: 50 }, opts());
    expect(state.status).toBe("succeeded");
    expect(path(state)).toEqual(["start:succeeded", "check:succeeded", "auto:succeeded", "notify:succeeded", "done:succeeded"]);
    expect(state.vars).toEqual({ approved_by: "policy" });
    expect(approvalsRequested).toEqual([]);
    expect(state.finishedAt).toBe(T0.toISOString());
    expect(logs.at(-1)!.message).toBe("Execution succeeded");
    expect(state.steps.map((s) => s.idempotencyKey)).toEqual(["x1:1:start", "x1:2:check", "x1:3:auto", "x1:4:notify", "x1:5:done"]);
  });

  test("large amount pauses at the approval", () => {
    const { state, approvalsRequested } = createExecution(purchaseGraph(), "x2", { amount: 5000 }, opts());
    expect(state.status).toBe("waiting_approval");
    expect(path(state)).toEqual(["start:succeeded", "check:succeeded", "approve:waiting_approval"]);
    expect(approvalsRequested.map((s) => s.nodeId)).toEqual(["approve"]);
  });

  test("condition errors fail the execution", () => {
    const g = purchaseGraph();
    g.nodes[1]!.data.expression = "input.amount * 'x'";
    const { state } = createExecution(g, "x3", { amount: 5 }, opts());
    expect(state.status).toBe("failed");
    expect(state.error).toContain("needs two numbers");
    expect(state.steps.at(-1)!.status).toBe("failed");
  });

  test("failing End outcome marks the execution failed", () => {
    const g: Graph = { nodes: [n("s", "start"), n("z", "end", { outcome: "failed" })], edges: [e("s", "z")] };
    expect(createExecution(g, "x", {}, opts()).state.status).toBe("failed");
  });
});

describe("engine: approvals", () => {
  const waiting = () => createExecution(purchaseGraph(), "a1", { amount: 5000 }, o()).state;

  test("approve resumes to success", () => {
    const s = waiting();
    const step = s.steps.find((x) => x.status === "waiting_approval")!;
    const r = advance(purchaseGraph(), s, { type: "decision", stepId: step.id, decision: "approved", by: "u1", comment: "ok" }, o());
    expect(r.state.status).toBe("succeeded");
    expect(path(r.state)).toEqual(["start:succeeded", "check:succeeded", "approve:succeeded", "notify:succeeded", "done:succeeded"]);
    expect(r.state.steps[2]!.output).toEqual({ decision: "approved", by: "u1", comment: "ok" });
    expect(r.state.vars.approval_approve).toBe("approved");
    // input state untouched (pure)
    expect(s.status).toBe("waiting_approval");
  });

  test("reject follows the rejected branch", () => {
    const s = waiting();
    const r = advance(purchaseGraph(), s, { type: "decision", stepId: s.steps[2]!.id, decision: "rejected", by: "u1" }, o());
    expect(r.state.status).toBe("failed");
    expect(path(r.state).at(-1)).toBe("denied:succeeded");
  });

  test("reject with no rejected branch ends as rejected", () => {
    const g = purchaseGraph();
    g.edges = g.edges.filter((x) => x.sourceHandle !== "rejected");
    const s = createExecution(g, "a2", { amount: 5000 }, o()).state;
    const r = advance(g, s, { type: "decision", stepId: s.steps[2]!.id, decision: "rejected", by: "u1" }, o());
    expect(r.state.status).toBe("rejected");
    expect(r.state.finishedAt).not.toBeNull();
  });

  test("a decision is applied only once", () => {
    const s = waiting();
    const ev = { type: "decision", stepId: s.steps[2]!.id, decision: "approved", by: "u1" } as const;
    const r = advance(purchaseGraph(), s, ev, o());
    expect(() => advance(purchaseGraph(), r.state, ev, o())).toThrow(EngineError);
    const sOther = waiting();
    expect(() => advance(purchaseGraph(), sOther, { ...ev, stepId: sOther.steps[0]!.id }, o())).toThrow("already been decided");
    expect(() => advance(purchaseGraph(), sOther, { ...ev, stepId: "nope" }, o())).toThrow("Unknown step");
  });

  test("cancel skips the waiting step", () => {
    const r = advance(purchaseGraph(), waiting(), { type: "cancel", by: "u1" }, o());
    expect(r.state.status).toBe("cancelled");
    expect(r.state.steps[2]!.status).toBe("skipped");
  });

  test("ticks on a terminal execution are no-ops; other events throw", () => {
    const done = createExecution(purchaseGraph(), "t", { amount: 1 }, o()).state;
    expect(advance(purchaseGraph(), done, { type: "tick" }, o()).state).toEqual(done);
    expect(() => advance(purchaseGraph(), done, { type: "cancel", by: "u" }, o())).toThrow("already succeeded");
  });

  test("sequential approvals", () => {
    const g: Graph = {
      nodes: [n("s", "start"), n("a1", "approval"), n("a2", "approval"), n("z", "end")],
      edges: [e("s", "a1"), e("a1", "a2", "approved"), e("a2", "z", "approved")],
    };
    let s = createExecution(g, "seq", {}, o()).state;
    s = advance(g, s, { type: "decision", stepId: s.steps[1]!.id, decision: "approved", by: "u" }, o()).state;
    expect(s.status).toBe("waiting_approval");
    s = advance(g, s, { type: "decision", stepId: s.steps[2]!.id, decision: "approved", by: "u" }, o()).state;
    expect(s.status).toBe("succeeded");
  });
});

describe("engine: retries and resume", () => {
  const flaky = (failTimes: number, maxAttempts = 3, backoffMs = 1000): Graph => ({
    nodes: [n("s", "start"), n("f", "action", { action: "simulated_flaky", failTimes, maxAttempts, backoffMs }), n("z", "end")],
    edges: [e("s", "f"), e("f", "z")],
  });

  test("schedules a retry with exponential backoff and resumes when due", () => {
    const g = flaky(2);
    const r1 = createExecution(g, "r", {}, o());
    const f = () => r1.state.steps[1]!;
    expect(r1.state.status).toBe("running");
    expect(f()).toMatchObject({ status: "pending", attempt: 1, error: "Simulated failure 1 of 2" });
    expect(r1.state.nextRunAt).toBe("2026-01-01T00:00:01.000Z");

    // Not yet due: nothing happens.
    const early = advance(g, r1.state, { type: "tick" }, o(new Date(T0.getTime() + 500)));
    expect(early.state.steps[1]!.attempt).toBe(1);

    const r2 = advance(g, r1.state, { type: "tick" }, o(new Date(T0.getTime() + 1000)));
    expect(r2.state.steps[1]).toMatchObject({ status: "pending", attempt: 2 });
    expect(r2.state.nextRunAt).toBe("2026-01-01T00:00:03.000Z"); // 1000 * 2^1 after t+1s

    const r3 = advance(g, r2.state, { type: "tick" }, o(new Date(T0.getTime() + 3000)));
    expect(r3.state.status).toBe("succeeded");
    expect(r3.state.steps[1]).toMatchObject({ status: "succeeded", attempt: 3, output: { attempts: 3 }, error: null });
    expect(r3.logs.some((l) => l.message === "Action simulated_flaky succeeded")).toBe(true);
  });

  test("gives up after maxAttempts", () => {
    const g = flaky(5, 2, 0);
    const r = createExecution(g, "r2", {}, o());
    expect(r.state.status).toBe("failed");
    expect(r.state.steps[1]).toMatchObject({ status: "failed", attempt: 2 });
    expect(r.logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  test("zero backoff retries inside one call", () => {
    const r = createExecution(flaky(1, 3, 0), "r3", {}, o());
    expect(r.state.status).toBe("succeeded");
    expect(r.state.steps[1]!.attempt).toBe(2);
  });

  test("set_variable failures retry too and vars flow to later conditions", () => {
    const g: Graph = {
      nodes: [
        n("s", "start"),
        n("v", "action", { action: "set_variable", key: "total", value: "input.qty * input.price" }),
        n("c", "condition", { expression: "vars.total > 100" }),
        n("hi", "end"),
        n("lo", "end"),
      ],
      edges: [e("s", "v"), e("v", "c"), e("c", "hi", "true"), e("c", "lo", "false")],
    };
    expect(path(createExecution(g, "v1", { qty: 3, price: 50 }, o()).state).at(-1)).toBe("hi:succeeded");
    expect(path(createExecution(g, "v2", { qty: 1, price: 50 }, o()).state).at(-1)).toBe("lo:succeeded");
    const bad = createExecution(g, "v3", { qty: "x", price: 1 }, o()).state;
    expect(bad.status).toBe("running"); // retry scheduled
    expect(bad.steps[1]!.error).toContain("needs two numbers");
  });

  test("step limit stops runaway executions", () => {
    const nodes = [n("s", "start"), ...Array.from({ length: 8 }, (_, i) => n(`a${i}`, "action", { action: "log", message: "x" })), n("z", "end")];
    const edges = nodes.slice(1).map((x, i) => e(nodes[i]!.id, x.id));
    const r = createExecution({ nodes, edges }, "lim", {}, { ...o(), maxSteps: 5 });
    expect(r.state.status).toBe("failed");
    expect(r.state.error).toContain("Step limit");
  });
});
