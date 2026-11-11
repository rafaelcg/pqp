import { afterEach, describe, expect, it, vi } from "vitest";

type Tick = { state: string };
interface FakePlayer {
  subscribe(listener: (tick: Tick) => void): () => void;
  emit(state: string): void;
}
interface FakeEngine {
  player: FakePlayer;
  destroy: ReturnType<typeof vi.fn>;
}

function fakeEngine(): FakeEngine {
  const listeners = new Set<(tick: Tick) => void>();
  return {
    player: {
      subscribe(listener) {
        listeners.add(listener);
        listener({ state: "stopped" });
        return () => listeners.delete(listener);
      },
      emit(state) {
        for (const listener of listeners) listener({ state });
      },
    },
    destroy: vi.fn(async () => undefined),
  };
}

const pending: Array<(engine: FakeEngine) => void> = [];
const created: FakeEngine[] = [];

vi.mock("@/lib/jam", () => ({
  JamEngine: {
    create: () =>
      new Promise<FakeEngine>((resolve) => {
        const engine = fakeEngine();
        created.push(engine);
        pending.push(() => resolve(engine));
      }),
  },
}));

afterEach(async () => {
  const { releaseJamEngine } = await import("./jam-session");
  // settle anything still pending so the next test starts clean
  while (pending.length) pending.shift()?.(fakeEngine());
  await releaseJamEngine();
  created.length = 0;
});

describe("the sidebar's playing flag follows the one live engine", () => {
  it("follows the engine's transport and clears when the Jam is left", async () => {
    const { getJamEngine, releaseJamEngine } = await import("./jam-session");
    const { isJamPlaying } = await import("./jam-now-playing");
    const asked = getJamEngine();
    pending.shift()?.(created[0]!);
    await asked;
    created[0]!.player.emit("playing");
    expect(isJamPlaying()).toBe(true);
    await releaseJamEngine();
    expect(isJamPlaying()).toBe(false);
  });

  it("an engine released while it was still being created never takes the flag over", async () => {
    const { getJamEngine, releaseJamEngine } = await import("./jam-session");
    const { isJamPlaying } = await import("./jam-now-playing");
    const first = getJamEngine();
    const released = releaseJamEngine();
    const second = getJamEngine();
    // the newer engine resolves first, the released one afterwards
    pending[1]?.(created[1]!);
    const live = await second;
    created[1]!.player.emit("playing");
    expect(isJamPlaying()).toBe(true);
    pending[0]?.(created[0]!);
    await first;
    await released;
    // the stale engine did not replace the live subscription: the live one still drives the flag
    created[1]!.player.emit("paused");
    expect(isJamPlaying()).toBe(false);
    created[1]!.player.emit("playing");
    expect(isJamPlaying()).toBe(true);
    expect(live).toBe(created[1]);
    expect(created[0]!.destroy).toHaveBeenCalledTimes(1);
  });
});
