import { describe, expect, it } from "vitest";
import {
  createSfuStatsReader,
  sfuHostFromUrl,
  type SfuRoomLike,
} from "./sfu-stats.js";

function harness(initial: { host?: string | null; rooms?: SfuRoomLike[] } = {}) {
  let host: string | null = initial.host === undefined ? "sfu.pqp.gg" : initial.host;
  let rooms: SfuRoomLike[] = initial.rooms ?? [];
  let mode: "ok" | "fail" | "hang" = "ok";
  let calls = 0;
  let clock = 1_000_000;
  const reader = createSfuStatsReader({
    host: () => host,
    listRooms: async () => {
      calls += 1;
      if (mode === "fail") throw new Error("connect ECONNREFUSED");
      if (mode === "hang") return new Promise<never>(() => {});
      return rooms;
    },
    now: () => clock,
    cacheTtlMs: 10_000,
    timeoutMs: 50,
  });
  return {
    reader,
    calls: () => calls,
    setHost: (h: string | null) => { host = h; },
    setRooms: (r: SfuRoomLike[]) => { rooms = r; },
    setMode: (m: typeof mode) => { mode = m; },
    tick: (ms: number) => { clock += ms; },
  };
}

describe("sfuHostFromUrl", () => {
  it("keeps the hostname and nothing else", () => {
    expect(sfuHostFromUrl("wss://sfu.pqp.gg")).toBe("sfu.pqp.gg");
    expect(sfuHostFromUrl("wss://SFU.pqp.gg:443/rtc?x=1")).toBe("sfu.pqp.gg");
    expect(sfuHostFromUrl("https://pqp-abc123.livekit.cloud")).toBe("pqp-abc123.livekit.cloud");
    expect(sfuHostFromUrl("sfu.pqp.gg")).toBe("sfu.pqp.gg");
  });

  it("gives null for nothing and for garbage, never the raw value", () => {
    expect(sfuHostFromUrl(undefined)).toBeNull();
    expect(sfuHostFromUrl("   ")).toBeNull();
    expect(sfuHostFromUrl("wss://")).toBeNull();
  });
});

describe("sfu stats reader", () => {
  it("reports not configured without a host, and never calls the SFU", async () => {
    const h = harness({ host: null });
    const s = await h.reader.read();
    expect(s).toMatchObject({ configured: false, host: null, reachable: null, rooms: null });
    expect(h.calls()).toBe(0);
  });

  it("counts rooms, participants and the largest room as the SFU reports them", async () => {
    const h = harness({
      rooms: [{ numParticipants: 3 }, { numParticipants: 7 }, { numParticipants: 0 }],
    });
    const s = await h.reader.read();
    expect(s).toMatchObject({
      configured: true,
      host: "sfu.pqp.gg",
      reachable: true,
      failure: null,
      rooms: 3,
      participants: 10,
      largestRoom: 7,
      cacheTtlSeconds: 10,
    });
    expect(typeof s.ms).toBe("number");
    expect(Date.parse(s.checkedAt ?? "")).not.toBeNaN();
  });

  it("serves the cached numbers for 10 s and asks again after", async () => {
    const h = harness({ rooms: [{ numParticipants: 2 }] });
    await h.reader.read();
    h.setRooms([{ numParticipants: 9 }]);
    h.tick(9_000);
    expect((await h.reader.read()).participants).toBe(2);
    expect(h.calls()).toBe(1);
    h.tick(2_000);
    expect((await h.reader.read()).participants).toBe(9);
    expect(h.calls()).toBe(2);
  });

  it("shares one in-flight probe between concurrent readers", async () => {
    const h = harness({ rooms: [{ numParticipants: 1 }] });
    const [a, b, c] = await Promise.all([h.reader.read(), h.reader.read(), h.reader.read()]);
    expect(h.calls()).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("marks an SFU that throws as unreachable, with counts withheld", async () => {
    const h = harness();
    h.setMode("fail");
    const s = await h.reader.read();
    expect(s).toMatchObject({
      configured: true,
      host: "sfu.pqp.gg",
      reachable: false,
      failure: "error",
      rooms: null,
      participants: null,
      largestRoom: null,
    });
    expect(JSON.stringify(s)).not.toContain("ECONNREFUSED");
  });

  it("gives up on a silent SFU at the timeout and says so", async () => {
    const h = harness();
    h.setMode("hang");
    const s = await h.reader.read();
    expect(s.reachable).toBe(false);
    expect(s.failure).toBe("timeout");
  });

  it("peeks at the last reading without ever taking a new one", async () => {
    const h = harness({ rooms: [{ numParticipants: 3 }] });
    // Nothing has been probed yet, so there is nothing to report.
    expect(h.reader.peek()).toBeNull();
    expect(h.calls()).toBe(0);

    await h.reader.read();
    expect(h.calls()).toBe(1);

    const fresh = h.reader.peek();
    expect(fresh?.stats.participants).toBe(3);
    expect(fresh?.ageMs).toBe(0);

    // Well past the 10 s cache: peek still answers, still without calling.
    // This is the whole point — /status.json reads it on every request.
    h.tick(120_000);
    const stale = h.reader.peek();
    expect(stale?.stats.participants).toBe(3);
    expect(stale?.ageMs).toBe(120_000);
    expect(h.calls()).toBe(1);
  });

  it("peeks at nothing after a rollback to another host", () => {
    const h = harness({ rooms: [{ numParticipants: 3 }] });
    return h.reader.read().then(() => {
      h.setHost("pqp-abc123.livekit.cloud");
      // The old box's numbers must never be served under the new name, at
      // any age, and peek cannot go and fetch the new one.
      expect(h.reader.peek()).toBeNull();
      expect(h.calls()).toBe(1);
    });
  });

  it("does not serve one host's numbers under another host's name", async () => {
    const h = harness({ rooms: [{ numParticipants: 4 }] });
    expect((await h.reader.read()).host).toBe("sfu.pqp.gg");
    h.setHost("pqp-abc123.livekit.cloud");
    h.setRooms([]);
    const s = await h.reader.read();
    expect(s.host).toBe("pqp-abc123.livekit.cloud");
    expect(s.rooms).toBe(0);
    expect(h.calls()).toBe(2);
  });
});
