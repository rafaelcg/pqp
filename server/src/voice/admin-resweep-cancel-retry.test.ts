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
  upsertVoiceResweep: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  ),
}));
vi.mock("./registry.js", () => registry);

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../lib/log.js", () => ({ logEvent }));

const lk = vi.hoisted(() => ({
  listParticipants: vi.fn(async () => []),
}));
vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      listParticipants = lk.listParticipants;
    },
  };
});

const { cancelSfuPrivateResweep, evictSfuUsersExcept, resetSfuAdminClient, stopSfuResweeps } =
  await import("./admin.js");

function configureLiveKit() {
  process.env.LIVEKIT_URL = "wss://sfu.example.test";
  process.env.LIVEKIT_API_KEY = "key";
  process.env.LIVEKIT_API_SECRET = "secret";
  resetSfuAdminClient();
}

beforeEach(() => {
  vi.useFakeTimers();
  registry.isVoiceRegistryEnabled.mockReturnValue(true);
  registry.deleteVoiceResweep.mockReset();
  registry.upsertVoiceResweep.mockClear();
  lk.listParticipants.mockReset().mockResolvedValue([]);
  logEvent.mockClear();
  configureLiveKit();
});

afterEach(() => {
  stopSfuResweeps();
  vi.useRealTimers();
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  resetSfuAdminClient();
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

/**
 * Farol HIGH, 2026-09-13: `evictViewersOutsideAudience` used to fire
 * `cancelPrivateVoiceResweep` and continue straight on to `evictVoiceUsersExcept`,
 * which can write a replacement `voice_resweeps` row for the very same key.
 * A slow cancel delete landing after that replacement upsert would erase the
 * row the request just wrote, leaving a still-private channel with no
 * cluster resweep. The fix is ordering: await the cancellation to completion
 * before anything can schedule a replacement for the same key.
 */
describe("cancel-then-schedule ordering for the same key", () => {
  it("delete lands before the replacement upsert when the caller awaits cancellation first", async () => {
    const order: string[] = [];
    registry.deleteVoiceResweep.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push("delete");
    });
    registry.upsertVoiceResweep.mockImplementation(async () => {
      order.push("upsert");
    });

    const cancel = cancelSfuPrivateResweep("private-channel-a");
    await vi.advanceTimersByTimeAsync(100);
    await cancel;

    await evictSfuUsersExcept(
      "private-channel-a",
      new Set(["user-1"]),
      new Map(),
    );

    expect(order).toEqual(["delete", "upsert"]);
  });

  it("an unawaited cancel can let the delete land after the replacement upsert (the bug this ordering prevents)", async () => {
    const order: string[] = [];
    registry.deleteVoiceResweep.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push("delete");
    });
    registry.upsertVoiceResweep.mockImplementation(async () => {
      order.push("upsert");
    });

    void cancelSfuPrivateResweep("private-channel-a"); // fire-and-forget: the old bug
    await evictSfuUsersExcept(
      "private-channel-a",
      new Set(["user-1"]),
      new Map(),
    );
    await vi.advanceTimersByTimeAsync(100);

    // The replacement lands first and the cancel's delete lands second — on
    // a real `DELETE FROM voice_resweeps WHERE key = $1` this would erase
    // the row the upsert just wrote, exactly what the HIGH comment flagged.
    expect(order).toEqual(["upsert", "delete"]);
  });
});
