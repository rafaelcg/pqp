import { describe, expect, it } from "vitest";
import { BURST_GAP_MS, groupContacts } from "./report-timeline";

const T0 = new Date("2026-10-14T12:00:00.000Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

describe("groupContacts", () => {
  it("turns five calls in twenty minutes into one burst", () => {
    const times = [3, 8, 12, 18, 23].map(at);
    const bursts = groupContacts(times, times);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({ dms: 5, calls: 5, at: at(3), until: at(23) });
  });

  it("splits when the gap is longer than a burst allows", () => {
    const gap = BURST_GAP_MS / 60_000;
    const bursts = groupContacts([at(0), at(1), at(1 + gap + 1)], []);
    expect(bursts.map((b) => b.dms)).toEqual([2, 1]);
  });

  it("keeps a call and the DM it began with apart only by kind", () => {
    const bursts = groupContacts([at(5)], [at(5), at(40), at(41)]);
    expect(bursts.map((b) => [b.dms, b.calls])).toEqual([[1, 1], [0, 2]]);
  });

  it("is empty with nothing to group", () => {
    expect(groupContacts([], [])).toEqual([]);
  });
});
