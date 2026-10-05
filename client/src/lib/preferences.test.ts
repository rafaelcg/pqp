// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ updatePreferences: vi.fn() }));
vi.mock("@/lib/api", () => ({ updatePreferences: api.updatePreferences }));

const {
  bindPreferenceSyncAccount,
  failedPreferenceKeys,
  queuePreferenceSync,
  subscribePreferenceSync,
} = await import("@/lib/preferences");

/** Let the request's promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  api.updatePreferences.mockReset();
  api.updatePreferences.mockResolvedValue({ preferences: {} });
});

afterEach(async () => {
  // Clear whatever a test left unsent so the next one starts clean.
  api.updatePreferences.mockResolvedValue({ preferences: {} });
  queuePreferenceSync({ muteOnJoin: false, theme: "system" }, { immediate: true });
  await settle();
});

describe("preference sync", () => {
  it("reports the keys of a request the account refused", async () => {
    api.updatePreferences.mockRejectedValueOnce(new Error("offline"));
    const listener = vi.fn();
    const unsubscribe = subscribePreferenceSync(listener);
    queuePreferenceSync({ theme: "dark" }, { immediate: true });
    await settle();
    expect(failedPreferenceKeys()).toEqual(["theme"]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("sends an unsent key again with the next change, the newer value winning", async () => {
    api.updatePreferences.mockRejectedValueOnce(new Error("offline"));
    queuePreferenceSync({ theme: "dark", muteOnJoin: true }, { immediate: true });
    await settle();
    expect(failedPreferenceKeys()).toEqual(["theme", "muteOnJoin"]);

    queuePreferenceSync({ muteOnJoin: false }, { immediate: true });
    await settle();
    expect(api.updatePreferences).toHaveBeenLastCalledWith({
      theme: "dark",
      muteOnJoin: false,
    });
    expect(failedPreferenceKeys()).toEqual([]);
  });

  it("keeps failing keys flagged until a request carrying them lands", async () => {
    api.updatePreferences.mockRejectedValue(new Error("offline"));
    queuePreferenceSync({ theme: "dark" }, { immediate: true });
    await settle();
    queuePreferenceSync({ muteOnJoin: true }, { immediate: true });
    await settle();
    expect(failedPreferenceKeys()).toEqual(["theme", "muteOnJoin"]);
  });

  it("lets only the newest request answer for a key", async () => {
    let failOld!: (error: unknown) => void;
    api.updatePreferences.mockReturnValueOnce(
      new Promise((_, reject) => (failOld = reject)),
    );
    queuePreferenceSync({ theme: "dark" }, { immediate: true });
    queuePreferenceSync({ theme: "light" }, { immediate: true });
    await settle();
    // The older request fails after the newer one succeeded: not a failure.
    failOld(new Error("late"));
    await settle();
    expect(failedPreferenceKeys()).toEqual([]);
  });

  it("does not notify when nothing changed", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePreferenceSync(listener);
    queuePreferenceSync({ theme: "dark" }, { immediate: true });
    await settle();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("never replays one account's unsent values into another", async () => {
    bindPreferenceSyncAccount("account-a");
    api.updatePreferences.mockRejectedValueOnce(new Error("offline"));
    queuePreferenceSync({ theme: "dark" }, { immediate: true });
    await settle();
    expect(failedPreferenceKeys()).toEqual(["theme"]);

    bindPreferenceSyncAccount("account-b");
    expect(failedPreferenceKeys()).toEqual([]);
    queuePreferenceSync({ muteOnJoin: true }, { immediate: true });
    await settle();
    expect(api.updatePreferences).toHaveBeenLastCalledWith({ muteOnJoin: true });
  });

  it("ignores the answer to a request sent for the previous account", async () => {
    bindPreferenceSyncAccount("account-a");
    let fail!: (error: unknown) => void;
    api.updatePreferences.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    queuePreferenceSync({ theme: "dark" }, { immediate: true });
    bindPreferenceSyncAccount("account-b");
    fail(new Error("offline"));
    await settle();
    expect(failedPreferenceKeys()).toEqual([]);
    queuePreferenceSync({ muteOnJoin: true }, { immediate: true });
    await settle();
    expect(api.updatePreferences).toHaveBeenLastCalledWith({ muteOnJoin: true });
  });
});
