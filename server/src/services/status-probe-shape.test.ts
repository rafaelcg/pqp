import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { probeComponents, refreshSlowProbes, resetSlowProbes, settleSlowProbes } =
  await import("./status.js");

/** One sampler tick, then wait for the probe the tick itself never waits on. */
async function tick(): Promise<void> {
  await refreshSlowProbes();
  await settleSlowProbes();
}

type Probed = { key: string; ok: boolean | null | "unknown"; latencyMs?: number };

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
    vi.useRealTimers();
    resetSlowProbes();
    fakes.storageConfigured.mockReturnValue(false);
    fakes.gifsConfigured.mockReturnValue(false);
    fakes.voiceBackend.mockReturnValue("mesh");
    fakes.liveKitConfigured.mockReturnValue(false);
    fakes.peekSfuStats.mockReturnValue(null);
    fakes.trendingGifs.mockReset();
    fakes.trendingGifs.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await tick();
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(1);

    const gifs = await probe("gifs");
    expect(gifs.ok).toBe(true);
    expect(typeof gifs.latencyMs).toBe("number");
  });

  it("calls GIF search down when the provider refused", async () => {
    fakes.gifsConfigured.mockReturnValue(true);
    fakes.trendingGifs.mockRejectedValueOnce(new Error("HTTP 401"));
    await tick();

    const gifs = await probe("gifs");
    expect(gifs.ok).toBe(false);
  });

  it("does not ask the GIF provider again on the next sampler tick", async () => {
    fakes.gifsConfigured.mockReturnValue(true);
    await tick();
    await tick();
    await tick();
    // One every fifteen minutes, not one a minute: the sampler runs far more
    // often than this probe is worth paying for.
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(1);
  });

  it("refreshes the SFU reading from the sampler, where the cost belongs", async () => {
    fakes.gifsConfigured.mockReturnValue(false);
    await refreshSlowProbes();
    expect(fakes.readSfuStats).toHaveBeenCalled();
  });

  /* --------------------------------------------------------------
   * The sampler must survive the GIF provider, whatever it does.
   *
   * recordStatusSamples awaits refreshSlowProbes. If a hung upstream could
   * hold that open, status samples, uptime and the latency history would all
   * silently stop moving while the dashboard kept showing the last good
   * numbers, which is the worst shape a monitoring failure can take.
   * -------------------------------------------------------------- */

  it("does not wait on the GIF provider at all, hung or otherwise", async () => {
    fakes.gifsConfigured.mockReturnValue(true);
    // A promise that never settles. Nothing here may join it.
    fakes.trendingGifs.mockReturnValue(new Promise(() => {}));

    const settled = await Promise.race([
      refreshSlowProbes().then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);
    expect(settled).toBe("returned");
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(1);
  });

  it("starts no second probe while one is still running", async () => {
    fakes.gifsConfigured.mockReturnValue(true);
    let release: (() => void) | undefined;
    fakes.trendingGifs.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );

    await refreshSlowProbes();
    await refreshSlowProbes();
    await refreshSlowProbes();
    // Three sampler ticks over one slow provider is one socket, not three.
    // Otherwise a long incident accumulates them for as long as it lasts.
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(1);

    release?.();
  });

  it("starts no second probe even once the interval has come round again", async () => {
    // The sharp edge of the previous test. The interval guard alone happens
    // to cover the common case, because a probe normally finishes long
    // before it is due again. It stops covering it the moment a probe
    // outlives its own interval, and then nothing but the in-flight guard is
    // between a long incident and a socket per tick for its whole duration.
    vi.useFakeTimers();
    fakes.gifsConfigured.mockReturnValue(true);
    fakes.trendingGifs.mockReturnValue(new Promise(() => {}));

    await refreshSlowProbes();
    // Move the clock without letting the probe's own timeout fire, which is
    // the only way to hold one open past its interval.
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await refreshSlowProbes();
    await refreshSlowProbes();

    expect(fakes.trendingGifs).toHaveBeenCalledTimes(1);
  });

  it("records a probe that ran out of time as unknown, never as operational", async () => {
    vi.useFakeTimers();
    fakes.gifsConfigured.mockReturnValue(true);
    fakes.trendingGifs.mockReturnValue(new Promise(() => {}));

    await refreshSlowProbes();
    await vi.advanceTimersByTimeAsync(9_000);

    const gifs = await probe("gifs");
    // Not `true`. We asked and got nothing back; claiming "up" would be
    // inventing the half of the answer that never arrived.
    expect(gifs.ok).toBe("unknown");
    expect(gifs.ok).not.toBe(true);
    expectUnprobed(gifs);
  });

  it("reports an unknown probe as degraded and keeps it out of uptime", async () => {
    vi.useFakeTimers();
    fakes.gifsConfigured.mockReturnValue(true);
    fakes.trendingGifs.mockReturnValue(new Promise(() => {}));
    await refreshSlowProbes();
    await vi.advanceTimersByTimeAsync(9_000);

    const gifs = (await probeComponents()).find((c) => c.key === "gifs");
    // The component is STILL LISTED, and its `ok` is not a boolean.
    // `typeof gifs?.ok` is `"undefined"` when the component is missing
    // entirely, which is not "unknown", it is "dropped", and the assertion
    // used to wave that through as a pass.
    expect(gifs).toBeDefined();
    // `recordStatusSamples` writes only components whose `ok` is a boolean,
    // so an unknown minute neither inflates nor deflates the uptime figure.
    expect(typeof gifs?.ok).not.toBe("boolean");
  });

  it("retries a minute after a bad probe instead of waiting fifteen", async () => {
    vi.useFakeTimers();
    fakes.gifsConfigured.mockReturnValue(true);
    fakes.trendingGifs.mockRejectedValueOnce(new Error("HTTP 502"));
    await tick();
    expect((await probe("gifs")).ok).toBe(false);

    // The very next tick is too soon for a *healthy* component (fifteen
    // minutes) but not for a bad one.
    fakes.trendingGifs.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await tick();
    // A recovery must be visible in a minute, not in a quarter of an hour,
    // and a single bad probe must not hold the component in a bad state for
    // long enough for anybody to be paged over it.
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(2);
    expect((await probe("gifs")).ok).toBe(true);
  });

  it("waits the full fifteen minutes after a good probe", async () => {
    vi.useFakeTimers();
    fakes.gifsConfigured.mockReturnValue(true);
    await tick();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await tick();
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await tick();
    expect(fakes.trendingGifs).toHaveBeenCalledTimes(2);
  });

  it("carries the field on exactly the components that were measured", async () => {
    fakes.storageConfigured.mockReturnValue(true);
    fakes.gifsConfigured.mockReturnValue(true);
    fakes.voiceBackend.mockReturnValue("livekit");
    fakes.liveKitConfigured.mockReturnValue(true);
    fakes.peekSfuStats.mockReturnValue(sfuReading(true, 42, 30_000));
    await tick();

    const withLatency = ((await probeComponents()) as Probed[])
      .filter((c) => "latencyMs" in c)
      .map((c) => c.key)
      .sort();
    // Everything here ran a clock over something. `api` is missing on
    // purpose and is the whole reason this file exists.
    expect(withLatency).toEqual(["database", "gifs", "storage", "voice"]);
  });
});
