import { describe, expect, it } from "vitest";
import type { JsonValue } from "@pqp/shared";
import { applyMergePatch, stateBytesAfter } from "./merge-patch";

describe("applyMergePatch (RFC 7396 test vectors)", () => {
  const vectors: Array<[JsonValue, JsonValue, JsonValue]> = [
    [{ a: "b" }, { a: "c" }, { a: "c" }],
    [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
    [{ a: "b" }, { a: null }, {}],
    [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
    [{ a: ["b"] }, { a: "c" }, { a: "c" }],
    [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
    [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
    [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
    [["a", "b"], ["c", "d"], ["c", "d"]],
    [{ a: "b" }, ["c"], ["c"]],
    [{ a: "foo" }, null, null],
    [{ a: "foo" }, "bar", "bar"],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: "b", c: null }, { a: "b" }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];

  it.each(vectors)("%j patched with %j is %j", (target, patch, expected) => {
    // the RFC's `{"e": null}` target keeps a null; our results are compared as JSON
    expect(JSON.parse(JSON.stringify(applyMergePatch(target, patch)))).toEqual(expected);
  });

  it("treats a missing target as an empty object for an object patch", () => {
    expect(JSON.parse(JSON.stringify(applyMergePatch(undefined, { a: 1, b: null })))).toEqual({ a: 1 });
  });

  it("does not touch its inputs", () => {
    const target = { a: { b: 1 } };
    const patch = { a: { b: null } };
    applyMergePatch(target, patch);
    expect(target).toEqual({ a: { b: 1 } });
    expect(patch).toEqual({ a: { b: null } });
  });

  it("keeps a key named __proto__ as a plain key and never reaches a prototype", () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as JsonValue;
    const merged = applyMergePatch({}, patch) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect(Object.keys(merged).sort()).toEqual(["__proto__", "ok"]);
  });
});

describe("stateBytesAfter", () => {
  it("counts the compact UTF-8 bytes of the merged state, not of the patch", () => {
    expect(stateBytesAfter({ a: "xxxx" }, { b: 1 })).toBe(JSON.stringify({ a: "xxxx", b: 1 }).length);
    expect(stateBytesAfter({ a: "xxxx" }, { a: null })).toBe(2);
    expect(stateBytesAfter(null, { n: "é" })).toBe(new TextEncoder().encode('{"n":"é"}').length);
  });
});
