import { describe, expect, it } from "vitest";
import { countedQuery, dbTxByPath, resetDbTxMetrics } from "./db-tx-metrics.js";

function fakePool(rows: unknown[] = []) {
  const calls: { text: string; params: unknown[] | undefined }[] = [];
  return {
    calls,
    query: async <T extends object = never>(text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

describe("db-tx-metrics", () => {
  it("starts empty", () => {
    resetDbTxMetrics();
    expect(dbTxByPath()).toEqual({});
  });

  it("counts one call under its label", async () => {
    resetDbTxMetrics();
    const pool = fakePool();

    await countedQuery(pool, "test.label", "SELECT 1");

    expect(dbTxByPath()).toEqual({ "test.label": 1 });
  });

  it("accumulates repeat calls to the same label", async () => {
    resetDbTxMetrics();
    const pool = fakePool();

    await countedQuery(pool, "test.label", "SELECT 1");
    await countedQuery(pool, "test.label", "SELECT 1");
    await countedQuery(pool, "test.label", "SELECT 1");

    expect(dbTxByPath()["test.label"]).toBe(3);
  });

  it("keeps separate labels apart", async () => {
    resetDbTxMetrics();
    const pool = fakePool();

    await countedQuery(pool, "a", "SELECT 1");
    await countedQuery(pool, "b", "SELECT 1");
    await countedQuery(pool, "a", "SELECT 1");

    expect(dbTxByPath()).toEqual({ a: 2, b: 1 });
  });

  it("passes the query and params through unchanged", async () => {
    resetDbTxMetrics();
    const pool = fakePool([{ id: 1 }]);

    const result = await countedQuery(pool, "test.label", "SELECT $1", ["x"]);

    expect(pool.calls).toEqual([{ text: "SELECT $1", params: ["x"] }]);
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  it("counts a call even when the underlying query rejects", async () => {
    resetDbTxMetrics();
    const failing = {
      query: async () => {
        throw new Error("boom");
      },
    };

    await expect(
      countedQuery(failing, "test.label", "SELECT 1"),
    ).rejects.toThrow("boom");
    // The round trip was issued — that is what the counter measures — even
    // though it failed on the other end.
    expect(dbTxByPath()["test.label"]).toBe(1);
  });

  it("resetDbTxMetrics clears every label", async () => {
    const pool = fakePool();
    await countedQuery(pool, "a", "SELECT 1");

    resetDbTxMetrics();

    expect(dbTxByPath()).toEqual({});
  });
});
