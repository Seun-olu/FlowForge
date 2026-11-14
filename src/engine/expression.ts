/**
 * Small, safe expression language for Condition nodes. Parsed into an AST and
 * interpreted — never passed to eval/Function. Supports:
 *   literals: 12, 1.5, "text", 'text', true, false, null
 *   paths:    input.amount, vars.region (own properties only)
 *   operators: ! - (unary), * / %, + -, < <= > >=, == !=, &&, ||, parentheses
 * Equality is strict (no coercion); arithmetic and ordering require numbers
 * (or two strings for ordering / `+`).
 */

export type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

type Node =
  | { k: "lit"; v: Value }
  | { k: "path"; parts: string[] }
  | { k: "un"; op: "!" | "-"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node };

export class ExpressionError extends Error {}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const MAX_LENGTH = 500;
const MAX_DEPTH = 40;

type Tok = { t: "num" | "str" | "id" | "op" | "eof"; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const ops = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "."];
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0], pos: i }); i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j]; j++; }
      }
      if (j >= src.length) throw new ExpressionError(`Unterminated string at ${i}`);
      out.push({ t: "str", v: s, pos: i }); i = j + 1; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], pos: i }); i += m[0].length; continue;
    }
    const op = ops.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected character "${c}" at ${i}`);
    out.push({ t: "op", v: op, pos: i }); i += op.length;
  }
  out.push({ t: "eof", v: "", pos: src.length });
  return out;
}

const BIN_PREC: Record<string, number> = {
  "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
};

export function parseExpression(src: string): Node {
  if (typeof src !== "string" || !src.trim()) throw new ExpressionError("Expression is empty");
  if (src.length > MAX_LENGTH) throw new ExpressionError(`Expression is longer than ${MAX_LENGTH} characters`);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const expect = (v: string) => {
    const t = next();
    if (t.v !== v || t.t === "str") throw new ExpressionError(`Expected "${v}" at ${t.pos}`);
  };

  function primary(depth: number): Node {
    if (depth > MAX_DEPTH) throw new ExpressionError("Expression is nested too deeply");
    const t = next();
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "op" && t.v === "(") { const e = binary(0, depth + 1); expect(")"); return e; }
    if (t.t === "op" && (t.v === "!" || t.v === "-")) return { k: "un", op: t.v, a: primary(depth + 1) };
    if (t.t === "id") {
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      const parts = [t.v];
      while (peek().t === "op" && peek().v === ".") {
        next();
        const id = next();
        if (id.t !== "id") throw new ExpressionError(`Expected a property name at ${id.pos}`);
        parts.push(id.v);
      }
      for (const part of parts) if (FORBIDDEN.has(part)) throw new ExpressionError(`"${part}" is not allowed`);
      return { k: "path", parts };
    }
    throw new ExpressionError(t.t === "eof" ? "Unexpected end of expression" : `Unexpected "${t.v}" at ${t.pos}`);
  }

  function binary(minPrec: number, depth: number): Node {
    let left = primary(depth);
    for (;;) {
      const t = peek();
      const prec = t.t === "op" ? BIN_PREC[t.v] : undefined;
      if (prec === undefined || prec < minPrec) break;
      next();
      const right = binary(prec + 1, depth + 1);
      left = { k: "bin", op: t.v, a: left, b: right };
    }
    return left;
  }

  const ast = binary(0, 0);
  if (peek().t !== "eof") throw new ExpressionError(`Unexpected "${peek().v}" at ${peek().pos}`);
  return ast;
}

function lookup(scope: Record<string, unknown>, parts: string[]): Value {
  let cur: unknown = scope;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, part)) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return (cur === undefined ? null : cur) as Value;
}

const isNum = (v: Value): v is number => typeof v === "number" && Number.isFinite(v);

function evalNode(n: Node, scope: Record<string, unknown>): Value {
  switch (n.k) {
    case "lit": return n.v;
    case "path": return lookup(scope, n.parts);
    case "un": {
      const a = evalNode(n.a, scope);
      if (n.op === "!") return !truthy(a);
      if (!isNum(a)) throw new ExpressionError("Unary - needs a number");
      return -a;
    }
    case "bin": {
      if (n.op === "&&") return truthy(evalNode(n.a, scope)) && truthy(evalNode(n.b, scope));
      if (n.op === "||") return truthy(evalNode(n.a, scope)) || truthy(evalNode(n.b, scope));
      const a = evalNode(n.a, scope);
      const b = evalNode(n.b, scope);
      switch (n.op) {
        case "==": return a === b;
        case "!=": return a !== b;
        case "<": case "<=": case ">": case ">=": {
          if (!((isNum(a) && isNum(b)) || (typeof a === "string" && typeof b === "string"))) return false;
          return n.op === "<" ? a < b : n.op === "<=" ? a <= b : n.op === ">" ? a > b : a >= b;
        }
        case "+":
          if (isNum(a) && isNum(b)) return a + b;
          if (typeof a === "string" && typeof b === "string") return a + b;
          throw new ExpressionError("+ needs two numbers or two strings");
        default: {
          if (!isNum(a) || !isNum(b)) throw new ExpressionError(`${n.op} needs two numbers`);
          if ((n.op === "/" || n.op === "%") && b === 0) throw new ExpressionError("Division by zero");
          return n.op === "-" ? a - b : n.op === "*" ? a * b : n.op === "/" ? a / b : a % b;
        }
      }
    }
  }
}

export function truthy(v: Value): boolean {
  return !(v === false || v === null || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));
}

export function evaluate(src: string, scope: Record<string, unknown>): Value {
  return evalNode(parseExpression(src), scope);
}

export function evaluateCondition(src: string, scope: Record<string, unknown>): boolean {
  return truthy(evaluate(src, scope));
}
