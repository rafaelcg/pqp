import { describe, expect, it, vi } from "vitest";

/**
 * `setWatchPartyState`'s `lowLatency` param is the ONLY thing that turns the
 * "Baixa latência (beta)" switch (`watch-party-options.tsx`) into
 * `channel_sessions.low_latency_requested` on the server
 * (`requestedHlsModeForChannel` in `server/src/voice/hls-remux.ts`, read
 * only at `goLive`). Pinning the request body here is what keeps
 * `App.tsx`'s `handleWatchPartyGoLive` honest about actually forwarding it —
 * a silent drop here would leave the switch doing nothing, with the party
 * still going live normally on the conventional ladder.
 */
const apiFetchMock = vi.fn().mockResolvedValue({ party: null });
vi.mock("./api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { setWatchPartyState } from "./watch-parties-api";

describe("setWatchPartyState", () => {
  it("sends only the state when lowLatency is not given", async () => {
    apiFetchMock.mockClear();
    await setWatchPartyState("party-1", "ended");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/watch-parties/party-1/state",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ state: "ended" }),
      }),
    );
  });

  it("forwards lowLatency: true alongside state: live", async () => {
    apiFetchMock.mockClear();
    await setWatchPartyState("party-1", "live", true);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/watch-parties/party-1/state",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ state: "live", lowLatency: true }),
      }),
    );
  });

  it("forwards lowLatency: false explicitly, rather than omitting it", async () => {
    // A host who turned the switch off must retract a previous session's
    // request, not silently keep it: the server writes this value
    // unconditionally on every goLive, but only if the client sends it.
    apiFetchMock.mockClear();
    await setWatchPartyState("party-1", "live", false);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/watch-parties/party-1/state",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ state: "live", lowLatency: false }),
      }),
    );
  });
});
