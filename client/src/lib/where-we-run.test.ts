import { describe, expect, it } from "vitest";
import {
  GRID,
  REGIONS,
  SAMPLE_CALLERS,
  landDotsPath,
  parseStatus,
  project,
  summarise,
  visitorFromTimeZone,
} from "./where-we-run";

/** The shape `GET /status.json` answers with today (key, label, state...). */
const LIVE = {
  state: "operational",
  components: [
    { key: "api", label: "API", state: "operational", uptime24h: 1, uptime7d: 1 },
    { key: "voice", label: "Voice", state: "operational", latencyMs: 3, uptime24h: 1, uptime7d: 1 },
    { key: "voice-mia", label: "Voice (mia)", state: "operational", uptime24h: 1, uptime7d: 1 },
    { key: "voice-lhr", label: "Voice (lhr)", state: "operational", uptime24h: 1, uptime7d: 1 },
  ],
  checkedAt: "2026-09-24T10:25:24.169Z",
};

describe("parseStatus", () => {
  it("reads the three voice boxes from the live shape", () => {
    const reading = parseStatus(LIVE);
    expect(reading?.regions).toEqual({ gru: "operational", mia: "operational", lhr: "operational" });
    expect(reading?.overall).toBe("operational");
    expect(reading?.checkedAt?.toISOString()).toBe("2026-09-24T10:25:24.169Z");
  });

  it("never turns a box the endpoint did not report into green", () => {
    const reading = parseStatus({
      ...LIVE,
      components: LIVE.components.filter((c) => c.key !== "voice-lhr"),
    });
    expect(reading?.regions.lhr).toBe("unknown");
    expect(reading?.overall).toBe("unknown");
  });

  it("ignores the API's own overall state, which covers GIFs and storage", () => {
    const reading = parseStatus({ ...LIVE, state: "down" });
    expect(reading?.overall).toBe("operational");
  });

  it("maps an unexpected state to unknown, and refuses a body it cannot read", () => {
    const reading = parseStatus({
      components: [{ key: "voice", state: "disabled" }],
    });
    expect(reading?.regions.gru).toBe("unknown");
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus({ error: "status unavailable" })).toBeNull();
    expect(parseStatus("<html>")).toBeNull();
  });
});

describe("summarise", () => {
  it("reports the worst box, and unknown outranks green", () => {
    expect(summarise(["operational", "down", "degraded"])).toBe("down");
    expect(summarise(["operational", "degraded"])).toBe("degraded");
    expect(summarise(["operational", "unknown"])).toBe("unknown");
    expect(summarise(["operational", "operational"])).toBe("operational");
  });
});

describe("visitorFromTimeZone", () => {
  it("places visitors only in the countries the routing names", () => {
    expect(visitorFromTimeZone("America/Sao_Paulo")?.region).toBe("gru");
    expect(visitorFromTimeZone("America/New_York")?.region).toBe("mia");
    expect(visitorFromTimeZone("Europe/London")?.region).toBe("lhr");
    expect(visitorFromTimeZone("America/Indiana/Indianapolis")?.region).toBe("mia");
    expect(visitorFromTimeZone("America/Kentucky/Louisville")?.region).toBe("mia");
    expect(visitorFromTimeZone("America/Boise")?.region).toBe("mia");
  });

  it("stays generic anywhere else", () => {
    expect(visitorFromTimeZone("Europe/Berlin")).toBeNull();
    expect(visitorFromTimeZone("America/Mexico_City")).toBeNull();
    expect(visitorFromTimeZone("Asia/Tokyo")).toBeNull();
    expect(visitorFromTimeZone("toString")).toBeNull();
    expect(visitorFromTimeZone(undefined)).toBeNull();
  });
});

describe("the map", () => {
  it("draws every box and caller inside the crop", () => {
    for (const point of [...REGIONS, ...SAMPLE_CALLERS]) {
      const { x, y } = project(point);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(GRID.cols - 1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(GRID.rows - 1);
    }
  });

  it("puts each voice box on land", () => {
    const dots = new Set(
      [...landDotsPath().matchAll(/M(\d+) (\d+)h0((?:m1 0h0)*)/g)].flatMap((m) => {
        const start = Number(m[1]);
        const count = 1 + m[3].length / "m1 0h0".length;
        return Array.from({ length: count }, (_, i) => `${start + i},${m[2]}`);
      }),
    );
    expect(dots.size).toBeGreaterThan(1500);
    for (const region of REGIONS) {
      const { x, y } = project(region);
      const near = [-1, 0, 1].some((dx) =>
        [-1, 0, 1].some((dy) => dots.has(`${Math.round(x) + dx},${Math.round(y) + dy}`)),
      );
      expect(near, region.id).toBe(true);
    }
  });
});
