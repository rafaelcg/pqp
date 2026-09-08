import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What `/status.json` says about a component nobody measured.
 *
 * WHY THIS FILE EXISTS. The three cards that reported `0 ms` on the operator
 * dashboard were not broken probes: they were probes that never ran, sending
 * a zero the type had already said should be absent. A zero is not a small
 * latency, it is a claim of an impossibly fast round trip, and it is
 * indistinguishable at a glance from a real reading. So the rule pinned here
 * is narrow and absolute: **a component that was measured carries
 * `latencyMs`, a component that was not omits the field entirely.** Never a
 * zero standing in for either.
 *
 * No database, no network. Everything under the probes is a fake, which is
 * what lets each branch be forced.
 */

const fakes = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
  storageConfigured: vi.fn(() => false),
  headObject: vi.fn(async () => null),
  gifsConfigured: vi.fn(() => false),
  trendingGifs: vi.fn(async () => []),
  voiceBackend: vi.fn(() => "mesh" as string),
  liveKitConfigured: vi.fn(() => false),
  peekSfuStats: vi.fn(() => null as unknown),
  readSfuStats: vi.fn(async () => undefined),
}));

vi.mock("../db.js", () => ({ getPool: () => ({ query: fakes.query }) }));
vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: fakes.storageConfigured,
  headObject: fakes.headObject,
}));
vi.mock("./gifs.js", () => ({
  isGifSearchConfigured: fakes.gifsConfigured,
  trendingGifs: fakes.trendingGifs,
}));
vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: fakes.voiceBackend,
  isLiveKitConfigured: fakes.liveKitConfigured,
}));
vi.mock("../voice/sfu-stats.js", () => ({
  peekSfuStats: fakes.peekSfuStats,
  readSfuStats: fakes.readSfuStats,
}));

const { probeComponents, refreshSlowProbes, resetSlowProbes } = await import(
  "./status.js"
);

type Probed = { key: string; ok: boolean | null; latencyMs?: number };

async function probe(key: string): Promise<Probed> {
  const results = (await probeComponents()) as Probed[];
  const found = results.find((r) => r.key === key);
  if (!found) {
    throw new Error(`no such component: ${key}`);
  }
  return found;
}

/** The assertion this whole file is about, in one place. */
function expectUnprobed(component: Probed): void {
  expect(component).not.toHaveProperty("latencyMs");
  expect(Object.keys(component)).not.toContain("latencyMs");
}

function sfuReading(
  reachable: boolean,
  ms: number | null,
  ageMs: number,
): unknown {
  return { ageMs, stats: { configured: true, reachable, ms } };
}

describe("status probes: measured or absent, never zero", () => {
  beforeEach(() => {
    resetSlowProbes();
    fakes.storageConfigured.mockReturnValue(false);
    fakes.gifsConfigured.mockReturnValue(false);
    fakes.voiceBackend.mockReturnValue("mesh");
    fakes.liveKitConfigured.mockReturnValue(false);
    fakes.peekSfuStats.mockReturnValue(null);
    fakes.trendingGifs.mockClear();
  });

  it("omits latency for the API, which cannot time itself", async () => {
    const api = await probe("api");
    expect(api.ok).toBe(true);
    expectUnprobed(api);
  });

  it("keeps latency for the database, which is genuinely probed", async () => {
    const database = await probe("database");
    expect(database.ok).toBe(true);
    expect(typeof database.latencyMs).toBe("number");
    expect(fakes.query).toHaveBeenCalled();
  });

  it("omits latency for mesh voice, which has no server-side media", async () => {
    const voice = await probe("voice");
    expect(voice.ok).toBe(true);
    expectUnprobed(voice);
  });

  it("reports the SFU's last round trip when there is a recent one", async () => {
    fakes.voiceBackend.mockReturnValue("livekit");
    fakes.liveKitConfigured.mockReturnValue(true);
    fakes.peekSfuStats.mockReturnValue(sfuReading(true, 42, 30_000));

    const voice = await probe("voice");
    expect(voice.ok).toBe(true);
    expect(voice.latencyMs).toBe(42);
  });

  it("calls voice down when the SFU did not answer its last check", async () => {
    fakes.voiceBackend.mockReturnValue("livekit");
    fakes.liveKitConfigured.mockReturnValue(true);
    fakes.peekSfuStats.mockReturnValue(sfuReading(false, 3000, 30_000));

    const voice = await probe("voice");
    expect(voice.ok).toBe(false);
    // Nothing came back, so there is no round trip to report — the 3000 ms
    // is how long we waited, not how long the SFU took.
    expectUnprobed(voice);
  });

  it("drops a reading old enough that the sampler has plainly stopped", async () => {
    fakes.voiceBackend.mockReturnValue("livekit");
    fakes.liveKitConfigured.mockReturnValue(true);
    fakes.peekSfuStats.mockReturnValue(sfuReading(true, 42, 60 * 60_000));

    const voice = await probe("voice");
    // Back to the inferred verdict rather than an hour-old green with a
    // number on it.
    expect(voice.ok).toBe(true);
    expectUnprobed(voice);
  });

  it("never probes the SFU from the read path itself", async () => {
    fakes.voiceBackend.mockReturnValue("livekit");
    fakes.liveKitConfigured.mockReturnValue(true);
    await probeComponents();
    // /status.json is public and unauthenticated. Loading it must not be able
    // to make this process call the media server.
    expect(fakes.readSfuStats).not.toHaveBeenCalled();
  });

  it("reports GIF search as disabled, with no latency, when unconfigured", async () => {
    const gifs = await probe("gifs");
    expect(gifs.ok).toBeNull();
    expectUnprobed(gifs);
  });

  it("omits GIF latency until the scheduled probe has actually run", async () => {
    fakes.gifsConfigured.mockReturnValue(true);
    const gifs = await probe("gifs");
    expect(gifs.ok).toBe(true);
    expectUnprobed(gifs);
    expect(fakes.trendingGifs).not.toHaveBeenCalled();
  });

  it("reports a real GIF round trip once the scheduled probe has run", async () => {
    fakes.gifsConfigured.mockReturnValue(true);
    await refreshSlowProbes();
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(1);

    const gifs = await probe("gifs");
    expect(gifs.ok).toBe(true);
    expect(typeof gifs.latencyMs).toBe("number");
  });

  it("calls GIF search down when the provider refused", async () => {
    fakes.gifsConfigured.mockReturnValue(true);
    fakes.trendingGifs.mockRejectedValueOnce(new Error("HTTP 401"));
    await refreshSlowProbes();

    const gifs = await probe("gifs");
    expect(gifs.ok).toBe(false);
  });

  it("does not ask the GIF provider again on the next sampler tick", async () => {
    fakes.gifsConfigured.mockReturnValue(true);
    await refreshSlowProbes();
    await refreshSlowProbes();
    await refreshSlowProbes();
    // One every fifteen minutes, not one a minute: the sampler runs far more
    // often than this probe is worth paying for.
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(1);
  });

  it("refreshes the SFU reading from the sampler, where the cost belongs", async () => {
    fakes.gifsConfigured.mockReturnValue(false);
    await refreshSlowProbes();
    expect(fakes.readSfuStats).toHaveBeenCalled();
  });

  it("carries the field on exactly the components that were measured", async () => {
    fakes.storageConfigured.mockReturnValue(true);
    fakes.gifsConfigured.mockReturnValue(true);
    fakes.voiceBackend.mockReturnValue("livekit");
    fakes.liveKitConfigured.mockReturnValue(true);
    fakes.peekSfuStats.mockReturnValue(sfuReading(true, 42, 30_000));
    await refreshSlowProbes();

    const withLatency = ((await probeComponents()) as Probed[])
      .filter((c) => "latencyMs" in c)
      .map((c) => c.key)
      .sort();
    // Everything here ran a clock over something. `api` is missing on
    // purpose and is the whole reason this file exists.
    expect(withLatency).toEqual(["database", "gifs", "storage", "voice"]);
  });
});
