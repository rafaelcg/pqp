/**
 * Data for the landing's "where pqp runs" section.
 *
 * Nothing here is invented for the page. The three voice boxes are the ones
 * `/status.json` reports (`voice` is the home box in São Paulo, `voice-mia`
 * and `voice-lhr` the regions added in PR 800). The edge cities are the ones
 * seen serving one recent watch party; there were 17, and only the ones we
 * can name are drawn. The "calls" on the map are illustrations of the rule
 * (a call opens on the box nearest whoever joins first, by country), not
 * traffic.
 */

export type RegionId = "gru" | "mia" | "lhr";

export interface Region {
  id: RegionId;
  /** The component key in `GET /status.json`. */
  statusKey: string;
  lon: number;
  lat: number;
}

export const REGIONS: readonly Region[] = [
  { id: "gru", statusKey: "voice", lon: -46.63, lat: -23.55 },
  { id: "mia", statusKey: "voice-mia", lon: -80.19, lat: 25.76 },
  { id: "lhr", statusKey: "voice-lhr", lon: -0.13, lat: 51.51 },
];

/** Named cities from the edge log of one watch party (17 in total). */
export const EDGE_CITIES: readonly { lon: number; lat: number }[] = [
  { lon: -46.63, lat: -23.55 }, // São Paulo
  { lon: -43.2, lat: -22.91 }, // Rio de Janeiro
  { lon: -9.14, lat: 38.72 }, // Lisbon
  { lon: -0.13, lat: 51.51 }, // London
  { lon: -80.19, lat: 25.76 }, // Miami
  { lon: -71.06, lat: 42.36 }, // Boston
];

/**
 * Illustrative callers, three per box. A room's box is chosen from the first
 * joiner's country (`LIVEKIT_REGION_COUNTRIES`, documented as `US:mia,GB:lon`,
 * everyone else at home in São Paulo), so every caller here sits in a country
 * that rule sends to that box. A German or Mexican arc would be a guess about
 * configuration, so none is drawn.
 */
export const SAMPLE_CALLERS: readonly Place[] = [
  { lon: -34.88, lat: -8.05, region: "gru" }, // Recife
  { lon: -60.02, lat: -3.12, region: "gru" }, // Manaus
  { lon: -51.23, lat: -30.03, region: "gru" }, // Porto Alegre
  { lon: -74.01, lat: 40.71, region: "mia" }, // New York
  { lon: -87.63, lat: 41.88, region: "mia" }, // Chicago
  { lon: -118.24, lat: 34.05, region: "mia" }, // Los Angeles
  { lon: -3.19, lat: 55.95, region: "lhr" }, // Edinburgh
  { lon: -5.93, lat: 54.6, region: "lhr" }, // Belfast
  { lon: -2.24, lat: 53.48, region: "lhr" }, // Manchester
];

export interface Place {
  lon: number;
  lat: number;
  region: RegionId;
}

export function regionById(id: RegionId): Region {
  return REGIONS.find((r) => r.id === id) ?? REGIONS[0];
}

/**
 * A rough spot for the visitor and the box their call would open on, from
 * nothing but the browser's time zone: no request, no permission, no IP
 * lookup. Only zones in the three countries the routing names are mapped
 * (Brazil, the US, the UK); anyone else gets the generic map, because saying
 * where their call lands would be a guess.
 */
const ZONES: Record<string, Place> = {
  "America/Sao_Paulo": { lon: -46.63, lat: -23.55, region: "gru" },
  "America/Bahia": { lon: -38.5, lat: -12.97, region: "gru" },
  "America/Recife": { lon: -34.88, lat: -8.05, region: "gru" },
  "America/Fortaleza": { lon: -38.54, lat: -3.72, region: "gru" },
  "America/Maceio": { lon: -35.73, lat: -9.67, region: "gru" },
  "America/Belem": { lon: -48.5, lat: -1.46, region: "gru" },
  "America/Araguaina": { lon: -48.2, lat: -7.19, region: "gru" },
  "America/Santarem": { lon: -54.7, lat: -2.44, region: "gru" },
  "America/Manaus": { lon: -60.02, lat: -3.12, region: "gru" },
  "America/Boa_Vista": { lon: -60.67, lat: 2.82, region: "gru" },
  "America/Porto_Velho": { lon: -63.9, lat: -8.76, region: "gru" },
  "America/Rio_Branco": { lon: -67.81, lat: -9.97, region: "gru" },
  "America/Cuiaba": { lon: -56.1, lat: -15.6, region: "gru" },
  "America/Campo_Grande": { lon: -54.62, lat: -20.44, region: "gru" },
  "America/Noronha": { lon: -32.42, lat: -3.85, region: "gru" },
  "America/New_York": { lon: -74.01, lat: 40.71, region: "mia" },
  "America/Detroit": { lon: -83.05, lat: 42.33, region: "mia" },
  "America/Chicago": { lon: -87.63, lat: 41.88, region: "mia" },
  "America/Denver": { lon: -104.99, lat: 39.74, region: "mia" },
  "America/Phoenix": { lon: -112.07, lat: 33.45, region: "mia" },
  "America/Los_Angeles": { lon: -118.24, lat: 34.05, region: "mia" },
  "America/Puerto_Rico": { lon: -66.1, lat: 18.47, region: "mia" },
  "Europe/London": { lon: -0.13, lat: 51.51, region: "lhr" },
};

export function visitorFromTimeZone(timeZone: string | undefined): Place | null {
  if (!timeZone) return null;
  return Object.prototype.hasOwnProperty.call(ZONES, timeZone) ? ZONES[timeZone] : null;
}

// ---------------------------------------------------------------------------
// The live reading. Parsed defensively: this is a public endpoint and the
// page must never turn a shape it does not understand into a green light.

export type LiveState = "operational" | "degraded" | "down" | "unknown";

export interface LiveReading {
  overall: LiveState;
  regions: Record<RegionId, LiveState>;
  checkedAt: Date | null;
}

function asState(value: unknown): LiveState {
  return value === "operational" || value === "degraded" || value === "down"
    ? value
    : "unknown";
}

export function parseStatus(body: unknown): LiveReading | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { state?: unknown; components?: unknown; checkedAt?: unknown };
  if (!Array.isArray(record.components)) return null;
  const byKey = new Map<string, LiveState>();
  for (const item of record.components) {
    if (item && typeof item === "object") {
      const { key, state } = item as { key?: unknown; state?: unknown };
      if (typeof key === "string") byKey.set(key, asState(state));
    }
  }
  const regions = Object.fromEntries(
    REGIONS.map((r) => [r.id, byKey.get(r.statusKey) ?? "unknown"]),
  ) as Record<RegionId, LiveState>;
  const at = typeof record.checkedAt === "string" ? new Date(record.checkedAt) : null;
  return {
    overall: summarise(Object.values(regions)),
    regions,
    checkedAt: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

/** The voice boxes only: the worst of the three, and unknown beats green. */
export function summarise(states: LiveState[]): LiveState {
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("unknown")) return "unknown";
  return "operational";
}

// ---------------------------------------------------------------------------
// The dot map. An equirectangular crop of the Atlantic side of the world
// (125°W to 55°E, 62°N to 56°S) on a 2° grid, land from Natural Earth 1:110m
// (public domain). One row per line, runs of `start.length` in base 36.

export const GRID = { step: 2, lon0: -125, lat0: 62, cols: 91, rows: 60 } as const;

const LAND =
  "0.g,o.3,12.4,1u.6,22.h|0.g,o.4,u.1,1u.6,22.1,26.d|0.h,o.8,1o.1,1x.2,23.g|0.j,p.8,1o.1,1v.1,1x.1,22.h|0.m,n.b,1m.2,1q.1,1v.o|0.m,o.b,1m.1,1o.4,1t.q|1.t,y.1,1r.s|2.s,x.4,1p.u|1.u,w.1,1q.g,2a.5,2i.1|1.r,u.1,1q.5,1w.1,1z.6,2b.4,2g.3|1.r,1m.7,1v.1,1x.2,21.4,28.1,2c.3,2h.2|1.p,1m.5,1v.1,21.1,24.c,2i.1|2.n,1n.4,1x.2,22.1,24.c,2i.1|2.n,1r.5,29.a|4.k,1n.9,29.a|5.i,1m.d,21.2,28.b|5.1,7.b,k.2,1m.t,2g.3|6.9,m.1,1l.n,29.6,2h.2|8.6,m.1,1k.o,29.7|9.5,1j.q,2a.9|a.4,n.1,1j.q,2b.8|a.5,i.1,o.2,1j.r,2b.8|c.7,o.1,t.1,1j.r,2c.7|e.1,g.3,1j.s,2c.5|h.4,1j.t,2d.2|k.1,1j.u,2g.1|k.1,p.7,1k.w|m.1,o.9,1k.w|o.a,z.1,1m.6,1t.m|o.d,1v.k|o.e,1w.i|n.f,1w.g|n.i,1w.g|m.m,1x.e|m.n,1x.d|n.n,1y.d|o.l,1y.d|o.k,1y.d|p.j,1x.e,2f.1|q.i,1x.e,2e.2|s.f,1x.c,2d.3|s.f,1x.b,2d.2|s.e,1y.b,2d.2|s.c,1y.b,2d.2|s.b,1y.9|r.c,1z.8|r.b,20.6|r.a,20.6|r.9,20.2|r.7|q.8|q.6|q.5|q.4|q.3|p.5|p.4|p.4,w.2|q.3|";

/**
 * Every land dot as one SVG path of zero-length segments, drawn with a round
 * cap: ~1,900 dots in a single element instead of 1,900 circles.
 */
export function landDotsPath(): string {
  const parts: string[] = [];
  LAND.split("|").forEach((row, y) => {
    if (!row) return;
    for (const run of row.split(",")) {
      const [start, length] = run.split(".").map((n) => parseInt(n, 36));
      parts.push(`M${start} ${y}h0`);
      for (let i = 1; i < length; i++) parts.push("m1 0h0");
    }
  });
  return parts.join("");
}

export function project(point: { lon: number; lat: number }): { x: number; y: number } {
  return {
    x: (point.lon - GRID.lon0) / GRID.step,
    y: (GRID.lat0 - point.lat) / GRID.step,
  };
}

/** A gentle northward bow between two projected points, as a quadratic path. */
export function arcPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  // The perpendicular that points up the map (smaller y), a quarter of the span.
  let nx = -dy / (len || 1);
  let ny = dx / (len || 1);
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const lift = len * 0.25;
  const f = (n: number) => Math.round(n * 100) / 100;
  return `M${f(from.x)} ${f(from.y)}Q${f(mx + nx * lift)} ${f(my + ny * lift)} ${f(to.x)} ${f(to.y)}`;
}
