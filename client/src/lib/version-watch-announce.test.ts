import { describe, expect, it } from "vitest";
import { NO_FORCE, type ForceConfig } from "./client-version";
import { createVersionWatch } from "./version-watch";
import type { BuildStaleness } from "./update-prompt-state";

/**
 * The daily announcement, as the watch publishes it (the pure rule is in
 * `client-version.test.ts`). The reason it exists: on 2026-10-13 nineteen web
 * deploys were each announced to every open window, and a user wrote that
 * "de 10 em 10 segundos tem atualização".
 */

const running = { build: "abc123", builtAt: 1_000 };
const HOUR = 3_600_000;
// 2026-10-13 15:30 UTC.
const NOW = Date.UTC(2026, 9, 13, 15, 30);
const NEXT_MORNING = Date.UTC(2026, 9, 14, 9, 0);

function gated(
  over: {
    force?: ForceConfig | null;
    builtAt?: number | null;
    hour?: number | null;
    jitterMs?: number;
  } = {},
) {
  const published: BuildStaleness[] = [];
  const watch = createVersionWatch({
    running,
    fetchLatest: async () => ({
      build: "def456",
      builtAt: over.builtAt === undefined ? NOW - 5 * 60_000 : over.builtAt,
    }),
    fetchForceConfig: async () => (over.force === undefined ? NO_FORCE : over.force),
    updateWorker: async () => {},
    publish: (next) => published.push(next),
    now: () => NOW,
    announceHourUtc: over.hour === undefined ? 9 : over.hour,
    jitterMs: over.jitterMs ?? 0,
  });
  return { watch, published };
}

describe("the daily announcement (createVersionWatch)", () => {
  it("holds an ordinary new build until the next 09:00 UTC", async () => {
    const s = gated();
    await s.watch.check();
    expect(s.published[0]).toMatchObject({
      stale: true,
      forced: false,
      announceAt: NEXT_MORNING,
    });
  });

  it("spreads the morning with the page's own jitter", async () => {
    const s = gated({ jitterMs: 123_000 });
    await s.watch.check();
    expect(s.published[0]?.announceAt).toBe(NEXT_MORNING + 123_000);
  });

  it("announces at once when the operator pushed it (the force switch)", async () => {
    const s = gated({ force: { forceUpdate: true, minBuiltAt: null } });
    await s.watch.check();
    expect(s.published[0]).toMatchObject({ forced: true, announceAt: null });
  });

  it("announces at once when it is critical", async () => {
    const s = gated({
      force: { forceUpdate: false, minBuiltAt: null, criticalMinBuiltAt: NOW },
    });
    await s.watch.check();
    expect(s.published[0]).toMatchObject({ critical: true, announceAt: null });
  });

  it("announces at once for a bundle built before the operator's minimum", async () => {
    const s = gated({ force: { forceUpdate: false, minBuiltAt: 5_000 } });
    await s.watch.check();
    expect(s.published[0]).toMatchObject({ forced: true, announceAt: null });
  });

  it("holds nothing back with no hour: the way it was, for a self-host that wants it", async () => {
    const s = gated({ hour: null });
    await s.watch.check();
    expect(s.published[0]?.announceAt).toBeNull();
  });

  it("counts a held-back build as behind from the moment it is let out, not from when it was built", async () => {
    const s = gated({ builtAt: NOW - 20 * HOUR });
    await s.watch.check();
    // Built twenty hours ago, announced at 09:00 today: the slot is already past.
    expect(s.published[0]?.announceAt).toBe(Date.UTC(2026, 9, 13, 9, 0));
    expect(s.published[0]?.since).toBe(Date.UTC(2026, 9, 13, 9, 0));
    // A build from five minutes ago is behind from the next morning.
    const later = gated();
    await later.watch.check();
    expect(later.published[0]?.since).toBe(NEXT_MORNING);
  });

  it("carries the build time for the popover", async () => {
    const s = gated({ builtAt: NOW - 1000 });
    await s.watch.check();
    expect(s.published[0]?.builtAt).toBe(NOW - 1000);
  });

  it("uses the moment it first saw the build when the manifest has no time", async () => {
    const s = gated({ builtAt: null });
    await s.watch.check();
    expect(s.published[0]?.announceAt).toBe(NEXT_MORNING);
  });
});
