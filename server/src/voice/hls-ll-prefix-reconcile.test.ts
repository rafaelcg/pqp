import { describe, expect, it } from "vitest";
import {
  llPrefixStartedAt,
  planLlPrefixRepair,
  type LlPrefixRow,
} from "./hls-ll-prefix-reconcile.js";

const CHANNEL = "318a0954-6963-4f12-9890-0649d93810ac";
const NOW = Date.parse("2026-09-23T12:00:00Z");

/** The 2026-09-21 broadcast: the row says 773, the box wrote under 797. */
function row(overrides: Partial<LlPrefixRow> = {}): LlPrefixRow {
  return {
    id: "row-1",
    channelId: CHANNEL,
    objectPrefix: `live/${CHANNEL}/1790029937773-ll`,
    startedAtMs: 1_790_029_937_773,
    endedAtMs: Date.parse("2026-09-22T00:44:00Z"),
    cleaned: true,
    keepReplay: false,
    ...overrides,
  };
}

function plan(r: LlPrefixRow, bucketPrefixes: string[], claimed: string[] = []) {
  return planLlPrefixRepair({
    row: r,
    bucketPrefixes,
    claimedPrefixes: new Set(claimed),
    windowMs: 5_000,
    replayHours: 720,
    now: NOW,
  });
}

describe("planLlPrefixRepair", () => {
  it("repoints the 2026-09-21 row at the prefix the box actually wrote", () => {
    const real = `live/${CHANNEL}/1790029937797-ll`;
    expect(plan(row(), [real, `live/${CHANNEL}/1790000000000-ll`])).toEqual({
      kind: "repoint",
      row: row(),
      prefix: real,
      revive: true,
    });
  });

  it("leaves a row alone when its own prefix has objects", () => {
    expect(plan(row(), [row().objectPrefix]).kind).toBe("ok");
  });

  it("finds nothing outside the window", () => {
    expect(plan(row(), [`live/${CHANNEL}/1790029943000-ll`]).kind).toBe("missing");
  });

  it("refuses to guess between two candidates", () => {
    const result = plan(row(), [
      `live/${CHANNEL}/1790029937797-ll`,
      `live/${CHANNEL}/1790029939000-ll`,
    ]);
    expect(result.kind).toBe("ambiguous");
  });

  it("never takes a prefix another row already names", () => {
    const real = `live/${CHANNEL}/1790029937797-ll`;
    expect(plan(row(), [real], [real]).kind).toBe("taken");
  });

  it("refuses a row the sweep would delete on its next tick even when kept", () => {
    const result = plan(row({ endedAtMs: NOW - 721 * 60 * 60 * 1000 }), [
      `live/${CHANNEL}/1790029937797-ll`,
    ]);
    expect(result.kind).toBe("expired");
  });

  it("parses only this channel's LL directories", () => {
    expect(llPrefixStartedAt(`live/${CHANNEL}/1790029937797-ll`, CHANNEL)).toBe(1_790_029_937_797);
    expect(llPrefixStartedAt(`live/${CHANNEL}/1790029937797-ll/`, CHANNEL)).toBe(1_790_029_937_797);
    expect(llPrefixStartedAt(`live/${CHANNEL}/1790029937797-720p30`, CHANNEL)).toBeNull();
    expect(llPrefixStartedAt(`live/other/1790029937797-ll`, CHANNEL)).toBeNull();
  });
});
