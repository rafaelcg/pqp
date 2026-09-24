import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_HLS_PRESENCE_INTERVAL_MS } from "@pqp/shared";
import { createHlsPresenceBeat, sendHlsPresence } from "./hls-playback";

/**
 * The "still watching" beat a party's viewer counts are built from. Every
 * viewer sends it, so what matters is that it cannot send more than one per
 * interval and never sends for a paused picture.
 */
describe("createHlsPresenceBeat", () => {
  function setup(playing: { value: boolean }) {
    let now = 1_000_000;
    const send = vi.fn();
    const beat = createHlsPresenceBeat({
      sessionToken: "tok",
      isPlaying: () => playing.value,
      send,
      now: () => now,
    });
    return {
      beat,
      send,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  it("sends at once when playing, then at most once per interval", () => {
    const { beat, send, advance } = setup({ value: true });
    beat.beat();
    expect(send).toHaveBeenCalledWith("tok");
    // The 10 s timer and a `playing` event inside the same interval.
    for (let i = 0; i < 5; i += 1) {
      advance(5_000);
      beat.beat();
    }
    expect(send).toHaveBeenCalledTimes(1);
    advance(LIVE_HLS_PRESENCE_INTERVAL_MS);
    beat.beat();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not send for a paused picture, and sends as soon as it plays again", () => {
    const playing = { value: false };
    const { beat, send, advance } = setup(playing);
    beat.beat();
    advance(LIVE_HLS_PRESENCE_INTERVAL_MS * 3);
    beat.beat();
    expect(send).not.toHaveBeenCalled();
    playing.value = true;
    beat.beat();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing after stop", () => {
    const { beat, send } = setup({ value: true });
    beat.stop();
    beat.beat();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sendHlsPresence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts only the viewer token, with the Bearer the caller holds", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal("fetch", fetchMock);
    sendHlsPresence("tok", "jwt");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/live-hls\/presence$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ sessionToken: "tok" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
  });
});
