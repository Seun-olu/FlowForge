import { describe, expect, test } from "vitest";
import { evaluate, evaluateCondition, ExpressionError, parseExpression } from "./expression";

const scope = { input: { amount: 1500, region: "EU", tags: ["a"], nested: { ok: true } }, vars: { n: 0 } };

describe("expression evaluator", () => {
  test.each([
    ["input.amount > 1000", true],
    ["input.amount >= 1500 && input.region == 'EU'", true],
    ["input.amount < 10 || input.region != \"EU\"", false],
    ["!(input.amount > 1000)", false],
    ["input.nested.ok", true],
    ["1 + 2 * 3 == 7", true],
    ["(1 + 2) * 3 == 9", true],
    ["10 - 2 - 3 == 5", true],
    ["7 % 4 == 3 && 8 / 2 == 4", true],
    ["-input.amount < 0", true],
    ["'a' + 'b' == 'ab'", true],
    ["'b' > 'a'", true],
    ["input.missing == null", true],
    ["input.missing.deeper == null", true],
    ["vars.n", false],
    ["'1' == 1", false],
    ["'5' > 1", false],
  ])("%s → %s", (src, want) => {
    expect(evaluateCondition(src, scope)).toBe(want);
  });

  test("returns raw values", () => {
    expect(evaluate("input.amount * 2", scope)).toBe(3000);
    expect(evaluate("'x\\'y'", scope)).toBe("x'y");
    expect(evaluate("2.5 + 0.5", scope)).toBe(3);
  });

  test("short-circuits so the right side is not evaluated", () => {
    expect(evaluateCondition("false && 1 / 0", scope)).toBe(false);
    expect(evaluateCondition("true || 1 / 0", scope)).toBe(true);
  });

  test.each([
    ["", "empty"],
    ["input.", "property name"],
    ["1 +", "end of expression"],
    ["(1", "Expected"],
    ["a b", "Unexpected"],
    ["x = 1", "Unexpected character"],
    ["'open", "Unterminated"],
    ["input.__proto__", "not allowed"],
    ["input.constructor.prototype", "not allowed"],
    ["x".repeat(501), "longer"],
    ["(".repeat(60) + "1" + ")".repeat(60), "nested"],
  ])("rejects %j", (src, msg) => {
    expect(() => parseExpression(src)).toThrow(ExpressionError);
    expect(() => parseExpression(src)).toThrow(msg);
  });

  test("runtime type errors throw instead of coercing", () => {
    expect(() => evaluate("input.region * 2", scope)).toThrow("needs two numbers");
    expect(() => evaluate("1 / 0", scope)).toThrow("Division by zero");
    expect(() => evaluate("1 + 'a'", scope)).toThrow(ExpressionError);
  });

  test("cannot reach inherited properties or globals", () => {
    expect(evaluate("input.toString", scope)).toBeNull();
    expect(evaluate("process", scope)).toBeNull();
    expect(evaluate("input.tags.length", scope)).toBeNull();
  });
});
