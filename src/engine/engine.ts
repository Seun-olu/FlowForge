import { evaluate, evaluateCondition, type Value } from "./expression";
import { nodeData, outgoing, type Graph, type GraphNode, type Handle, type NodeType } from "./graph";

/**
 * Pure workflow interpreter. It never touches the database: the caller loads
 * an ExecutionState (under a row lock), calls `advance`, and persists the
 * returned state, logs and new approvals. Given the same state, event and
 * clock it always produces the same result, which is what makes resume and
 * retries safe.
 *
 * Step state machine: pending → running → waiting_approval → succeeded | failed | skipped
 * (`running` only exists inside a single advance call; a step that must retry
 * goes back to `pending` with a later `runAfter`).
 */

export type StepStatus = "pending" | "running" | "waiting_approval" | "succeeded" | "failed" | "skipped";
export type ExecutionStatus = "running" | "waiting_approval" | "succeeded" | "failed" | "rejected" | "cancelled";
export const TERMINAL: readonly ExecutionStatus[] = ["succeeded", "failed", "rejected", "cancelled"];

export interface Step {
  id: string;
  nodeId: string;
  nodeType: NodeType;
  seq: number;
  status: StepStatus;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  output: Value;
  error: string | null;
  runAfter: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ExecutionState {
  id: string;
  status: ExecutionStatus;
  input: Record<string, Value>;
  vars: Record<string, Value>;
  steps: Step[];
  error: string | null;
  nextRunAt: string | null;
  finishedAt: string | null;
}

export type EngineEvent =
  | { type: "tick" }
  | { type: "decision"; stepId: string; decision: "approved" | "rejected"; by: string; comment?: string }
  | { type: "cancel"; by: string };

export interface LogEntry {
  stepId: string | null;
  level: "info" | "warn" | "error";
  message: string;
  data?: Value;
}

export interface EngineOptions {
  now: Date;
  newId: () => string;
  maxSteps?: number;
}

export interface AdvanceResult {
  state: ExecutionState;
  logs: LogEntry[];
  /** Steps that entered waiting_approval during this call (need an approvals row). */
  approvalsRequested: Step[];
}

export class EngineError extends Error {
  constructor(message: string, readonly code: "not_waiting" | "terminal" | "unknown_step") {
    super(message);
  }
}

const iso = (d: Date) => d.toISOString();

export function createExecution(graph: Graph, id: string, input: Record<string, Value>, opts: EngineOptions): AdvanceResult {
  const start = graph.nodes.find((n) => n.type === "start");
  if (!start) throw new Error("Graph has no start node");
  const state: ExecutionState = { id, status: "running", input, vars: {}, steps: [], error: null, nextRunAt: null, finishedAt: null };
  const logs: LogEntry[] = [{ stepId: null, level: "info", message: "Execution started" }];
  enqueue(state, start, opts);
  return run(graph, state, logs, [], opts);
}

export function advance(graph: Graph, current: ExecutionState, event: EngineEvent, opts: EngineOptions): AdvanceResult {
  const state = structuredClone(current);
  const logs: LogEntry[] = [];
  const now = iso(opts.now);

  if (TERMINAL.includes(state.status)) {
    if (event.type === "tick") return { state, logs, approvalsRequested: [] };
    throw new EngineError(`Execution is already ${state.status}`, "terminal");
  }

  if (event.type === "cancel") {
    for (const s of state.steps) {
      if (s.status === "pending" || s.status === "waiting_approval") Object.assign(s, { status: "skipped", finishedAt: now });
    }
    finish(state, "cancelled", now, null);
    logs.push({ stepId: null, level: "warn", message: `Execution cancelled by ${event.by}` });
    return { state, logs, approvalsRequested: [] };
  }

  if (event.type === "decision") {
    const step = state.steps.find((s) => s.id === event.stepId);
    if (!step) throw new EngineError("Unknown step", "unknown_step");
    if (step.status !== "waiting_approval") throw new EngineError("This approval has already been decided", "not_waiting");
    Object.assign(step, {
      status: "succeeded",
      finishedAt: now,
      output: { decision: event.decision, by: event.by, comment: event.comment ?? "" },
    });
    logs.push({ stepId: step.id, level: "info", message: `Approval ${event.decision}`, data: { by: event.by } });
    state.vars[`approval_${step.nodeId}`] = event.decision;
    const node = graph.nodes.find((n) => n.id === step.nodeId)!;
    const edge = outgoing(graph, node.id, event.decision)[0];
    if (edge) {
      enqueue(state, graph.nodes.find((n) => n.id === edge.target)!, opts);
      state.status = "running";
    } else {
      // Only "rejected" may be left unconnected (validation guarantees "approved").
      finish(state, "rejected", now, null);
      logs.push({ stepId: null, level: "warn", message: "Execution rejected" });
    }
  }

  return run(graph, state, logs, [], opts);
}

function enqueue(state: ExecutionState, node: GraphNode, opts: EngineOptions) {
  const seq = state.steps.length + 1;
  const maxAttempts = node.type === "action" ? nodeData(node as GraphNode & { type: "action" }).maxAttempts : 1;
  state.steps.push({
    id: opts.newId(),
    nodeId: node.id,
    nodeType: node.type,
    seq,
    status: "pending",
    attempt: 0,
    maxAttempts,
    idempotencyKey: `${state.id}:${seq}:${node.id}`,
    output: null,
    error: null,
    runAfter: null,
    startedAt: null,
    finishedAt: null,
  });
}

function finish(state: ExecutionState, status: ExecutionStatus, now: string, error: string | null) {
  state.status = status;
  state.finishedAt = now;
  state.nextRunAt = null;
  state.error = error;
}

function run(graph: Graph, state: ExecutionState, logs: LogEntry[], approvals: Step[], opts: EngineOptions): AdvanceResult {
  const now = iso(opts.now);
  const maxSteps = opts.maxSteps ?? 100;
  state.nextRunAt = null;

  for (;;) {
    if (TERMINAL.includes(state.status)) break;
    const step = state.steps.find((s) => s.status === "pending");
    if (!step) break;
    if (step.runAfter && step.runAfter > now) {
      state.status = "running";
      state.nextRunAt = step.runAfter;
      break;
    }
    if (state.steps.length > maxSteps) {
      Object.assign(step, { status: "failed", error: "Step limit exceeded", finishedAt: now });
      finish(state, "failed", now, `Step limit of ${maxSteps} exceeded`);
      logs.push({ stepId: step.id, level: "error", message: "Step limit exceeded" });
      break;
    }

    const node = graph.nodes.find((n) => n.id === step.nodeId);
    if (!node) {
      finish(state, "failed", now, `Node ${step.nodeId} missing from graph`);
      break;
    }
    step.status = "running";
    step.attempt += 1;
    step.startedAt ??= now;
    const scope = { input: state.input, vars: state.vars };
    const next = (handle: Handle | null) => {
      const edge = outgoing(graph, node.id, handle)[0];
      if (edge) enqueue(state, graph.nodes.find((n) => n.id === edge.target)!, opts);
    };

    try {
      switch (node.type) {
        case "start":
          succeed(step, now, null);
          next(null);
          break;
        case "end": {
          const { outcome } = nodeData(node as GraphNode & { type: "end" });
          succeed(step, now, { outcome });
          finish(state, outcome, now, outcome === "failed" ? "Reached a failing End node" : null);
          logs.push({ stepId: step.id, level: outcome === "failed" ? "error" : "info", message: `Execution ${outcome}` });
          break;
        }
        case "condition": {
          const { expression } = nodeData(node as GraphNode & { type: "condition" });
          const result = evaluateCondition(expression, scope);
          succeed(step, now, { result });
          logs.push({ stepId: step.id, level: "info", message: `Condition evaluated to ${result}`, data: { expression } });
          next(result ? "true" : "false");
          break;
        }
        case "approval":
          step.status = "waiting_approval";
          state.status = "waiting_approval";
          approvals.push(step);
          logs.push({ stepId: step.id, level: "info", message: "Waiting for approval" });
          break;
        case "action": {
          const d = nodeData(node as GraphNode & { type: "action" });
          const output = runAction(d, step, scope, state);
          succeed(step, now, output);
          logs.push({ stepId: step.id, level: "info", message: `Action ${d.action} succeeded`, data: output });
          next(null);
          break;
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (node.type === "action" && step.attempt < step.maxAttempts) {
        const { backoffMs } = nodeData(node as GraphNode & { type: "action" });
        const delay = backoffMs * 2 ** (step.attempt - 1);
        Object.assign(step, { status: "pending", error: message, runAfter: iso(new Date(opts.now.getTime() + delay)) });
        logs.push({ stepId: step.id, level: "warn", message: `Attempt ${step.attempt} failed: ${message}; retrying in ${delay}ms` });
      } else {
        Object.assign(step, { status: "failed", error: message, finishedAt: now });
        finish(state, "failed", now, message);
        logs.push({ stepId: step.id, level: "error", message: `Step failed: ${message}` });
      }
    }
  }
  if (state.status === "waiting_approval" && !state.steps.some((s) => s.status === "waiting_approval")) state.status = "running";
  return { state, logs, approvalsRequested: approvals };
}

function succeed(step: Step, now: string, output: Value) {
  Object.assign(step, { status: "succeeded", output, error: null, runAfter: null, finishedAt: now });
}

function runAction(
  d: ReturnType<typeof nodeData<"action">>,
  step: Step,
  scope: Record<string, unknown>,
  state: ExecutionState,
): Value {
  switch (d.action) {
    case "set_variable": {
      const value = evaluate(d.value, scope);
      state.vars[d.key] = value;
      return { key: d.key, value };
    }
    case "log":
      return { message: d.message };
    case "simulated_flaky":
      // Demo/test action: fails its first `failTimes` attempts, then succeeds.
      if (step.attempt <= d.failTimes) throw new Error(`Simulated failure ${step.attempt} of ${d.failTimes}`);
      return { attempts: step.attempt };
  }
}
