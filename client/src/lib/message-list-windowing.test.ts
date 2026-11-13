import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchGlobalVoiceConfig = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchGlobalVoiceConfig: () => fetchGlobalVoiceConfig(),
}));

import {
  loadMessageListWindowingFlag,
  messageListWindowingOn,
  setMessageListWindowingForTests,
  startMessageListWindowingFlag,
} from "./message-list-windowing";

describe("message_list_windowing as the client learns it", () => {
  beforeEach(() => {
    fetchGlobalVoiceConfig.mockReset();
    setMessageListWindowingForTests(true);
  });

  it("is on before anything is asked", () => {
    expect(messageListWindowingOn()).toBe(true);
  });

  it("follows an explicit answer, both ways", async () => {
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ messageListWindowing: false });
    await loadMessageListWindowingFlag();
    expect(messageListWindowingOn()).toBe(false);
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ messageListWindowing: true });
    await loadMessageListWindowingFlag();
    expect(messageListWindowingOn()).toBe(true);
  });

  it("treats an older API that sends no field as on", async () => {
    setMessageListWindowingForTests(false);
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ audioSelfHeal: true });
    await loadMessageListWindowingFlag();
    expect(messageListWindowingOn()).toBe(true);
  });

  it("keeps the last answer through a failed ask", async () => {
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ messageListWindowing: false });
    await loadMessageListWindowingFlag();
    fetchGlobalVoiceConfig.mockRejectedValueOnce(new Error("offline"));
    await loadMessageListWindowingFlag();
    expect(messageListWindowingOn()).toBe(false);
  });

  it("a slow answer that was asked first never overwrites a newer one", async () => {
    let resolveSlow: (value: unknown) => void = () => {};
    fetchGlobalVoiceConfig.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSlow = resolve)),
    );
    const slow = loadMessageListWindowingFlag();
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ messageListWindowing: false });
    await loadMessageListWindowingFlag();
    resolveSlow({ messageListWindowing: true });
    await slow;
    expect(messageListWindowingOn()).toBe(false);
  });

  it("start asks once and again on a config refresh; the teardown puts it back to on", async () => {
    fetchGlobalVoiceConfig.mockResolvedValue({ messageListWindowing: false });
    const stop = startMessageListWindowingFlag();
    await vi.waitFor(() => expect(messageListWindowingOn()).toBe(false));
    stop();
    expect(messageListWindowingOn()).toBe(true);
  });
});
