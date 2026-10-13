import { describe, expect, it } from "vitest";
import {
  applyServerOrder,
  serverOrderUpdateSchema,
  updateServerOrderSchema,
} from "./server-order.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

const list = [{ id: A }, { id: B }, { id: C }];

describe("applyServerOrder", () => {
  it("follows the order given", () => {
    expect(applyServerOrder(list, [C, A, B]).map((s) => s.id)).toEqual([C, A, B]);
  });

  it("drops ids the list does not hold", () => {
    expect(applyServerOrder(list, ["gone", B, A, C]).map((s) => s.id)).toEqual([B, A, C]);
  });

  it("keeps servers the order does not name after the named ones, in place", () => {
    expect(applyServerOrder(list, [C]).map((s) => s.id)).toEqual([C, A, B]);
  });

  it("is a no-op for an empty order", () => {
    expect(applyServerOrder(list, [])).toEqual(list);
  });
});

describe("updateServerOrderSchema", () => {
  it("accepts ids with an optional origin", () => {
    expect(updateServerOrderSchema.safeParse({ serverIds: [A, B], origin: "tab" }).success).toBe(true);
    expect(updateServerOrderSchema.safeParse({ serverIds: [] }).success).toBe(true);
  });

  it("refuses repeats, non-uuids and an absent list", () => {
    expect(updateServerOrderSchema.safeParse({ serverIds: [A, A] }).success).toBe(false);
    expect(updateServerOrderSchema.safeParse({ serverIds: ["x"] }).success).toBe(false);
    expect(updateServerOrderSchema.safeParse({}).success).toBe(false);
  });
});

describe("serverOrderUpdateSchema", () => {
  it("parses the frame", () => {
    expect(
      serverOrderUpdateSchema.parse({ type: "server-order-update", serverIds: [A] }),
    ).toEqual({ type: "server-order-update", serverIds: [A] });
  });
});
