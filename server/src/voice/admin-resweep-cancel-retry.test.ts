import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pitfall 13/16 shape: a registry write (here, a delete) that only logs on
 * failure leaves the stale state behind. `cancelSfuPrivateResweep` deletes
 * the `voice_resweeps` row when the registry is on; if that delete fails and
 * nothing retries, `tickSfuResweeps` keeps evicting people from a room whose
 * access just widened, for up to the resweep's remaining window. These tests
 * exercise the retry in isolation, mocking only the registry boundary.
 */
const registry = vi.hoisted(() => ({
  isVoiceRegistryEnabled: vi.fn(() => true),
  deleteVoiceResweep: vi.fn<(key: string) => Promise<void>>(),
  claimVoiceResweeps: vi.fn(async () => []),
  hasLiveVoiceResweeps: vi.fn(async () => false),
  upsertVoiceResweep: vi.fn(async () => undefined),
}));
vi.mock("./registry.js", () => registry);

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return { ...actual, RoomServiceClient: class {} };
});

const { cancelSfuPrivateResweep } = await import("./admin.js");

beforeEach(() => {
  vi.useFakeTimers();
  registry.isVoiceRegistryEnabled.mockReturnValue(true);
  registry.deleteVoiceResweep.mockReset();
  logEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cancelSfuPrivateResweep: registry delete retry", () => {
  it("retries once and succeeds silently after a transient failure", async () => {
    registry.deleteVoiceResweep
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(undefined);

    const done = cancelSfuPrivateResweep("voice-a");
    await vi.advanceTimersByTimeAsync(250);
    await done;

    expect(registry.deleteVoiceResweep).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.sfuResweepCancelFailed",
      expect.objectContaining({ key: "private:voice-a" }),
    );
    expect(logEvent).not.toHaveBeenCalledWith(
      "voice.sfuResweepCancelGaveUp",
      expect.anything(),
    );
  });

  it("logs a distinct event when both attempts fail", async () => {
    registry.deleteVoiceResweep.mockRejectedValue(new Error("still down"));

    const done = cancelSfuPrivateResweep("voice-a");
    await vi.advanceTimersByTimeAsync(250);
    await done;

    expect(registry.deleteVoiceResweep).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenCalledWith(
      "voice.sfuResweepCancelGaveUp",
      expect.objectContaining({ key: "private:voice-a" }),
    );
  });

  it("does not touch the registry when it is off", async () => {
    registry.isVoiceRegistryEnabled.mockReturnValue(false);

    await cancelSfuPrivateResweep("voice-a");

    expect(registry.deleteVoiceResweep).not.toHaveBeenCalled();
  });
});
