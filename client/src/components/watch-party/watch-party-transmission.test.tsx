import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LiveHlsStream } from "@pqp/shared";
import {
  cameraLiveOnStream,
  streamAudioState,
  StreamMixControl,
  StreamQualityControl,
  WatchPartyTransmission,
} from "./watch-party-transmission";

/**
 * THE TWO AUDIENCES MUST NOT SILENTLY DIVERGE, and this is the surface that
 * stops them.
 *
 * A watch party has two audiences on two different paths. The seated room gets
 * the presenter's screen, its audio, every microphone and every camera, over
 * WebRTC. The seatless audience gets a Track Composite egress, which carries
 * exactly two tracks: the screen share and that share's OWN audio. So a host
 * who shared a whole screen, a window, or a tab without ticking its audio box
 * is broadcasting a silent film.
 *
 * Nothing else can tell them. They hear the film out of their own speakers;
 * the room they are talking to hears them perfectly; the player they can see
 * is the room's WebRTC track, not the transcode. Rafael went live on
 * 2026-09-09 with his webcam on and reasonably assumed it was going out.
 *
 * These cases are therefore about what a HOST IS TOLD, not about markup. The
 * panel is collapsed by default, so the warning has to survive being
 * collapsed, which is why the pill is asserted on the static render.
 */

function stream(over: Partial<LiveHlsStream> = {}): LiveHlsStream {
  return {
    hlsUrl: "/api/voice/hls-playlist/c/1",
    startedAt: 1_757_000_000_000,
    presenterPeerId: "peer-1",
    delaySeconds: 10,
    topHeight: 720,
    ...over,
  };
}

function markup(over: Partial<LiveHlsStream> | null) {
  return renderToStaticMarkup(
    <WatchPartyTransmission
      stream={over === null ? null : stream(over)}
      wentLiveAt="2026-09-09T12:00:00.000Z"
      audienceCount={137}
      isPresenting
      quality="auto"
      roomViewers={4}
      transport="livekit"
      now={new Date("2026-09-09T12:20:00.000Z")}
    />,
  );
}

describe("the presenter's camera, told to the host", () => {
  it("is on exactly when the server states a camera playlist", () => {
    expect(
      cameraLiveOnStream(
        stream({ cameraHlsUrl: "/api/voice/hls-playlist/c/1/cam360p30" }),
      ),
    ).toBe(true);
  });

  it("reads exactly like a server that predates the feature otherwise", () => {
    // No webcam on, a box that refused the camera for budget,
    // `LIVE_HLS_CAMERA=false`, or an API old enough to have never sent the
    // field: all four must be indistinguishable to the host.
    expect(cameraLiveOnStream(stream())).toBe(false);
    expect(cameraLiveOnStream(null)).toBe(false);
  });

  it("says nothing while the panel is collapsed, like every other detail row", () => {
    // Collapsed by default; the camera note sits beside the mixer and the
    // quality picker inside the same `{open && ...}` block, never in the
    // one-line summary the silent-audio pill deliberately escapes.
    expect(
      markup({ cameraHlsUrl: "/api/voice/hls-playlist/c/1/cam360p30" }),
    ).not.toContain("watch-party-tx-camera");
  });
});

describe("what the host is told the stream is carrying", () => {
  it("says the audience hears nothing when the transcode has no audio track", () => {
    expect(streamAudioState(stream({ hasAudio: false }))).toBe("none");
    expect(markup({ hasAudio: false })).toContain(
      "watch-party-tx-silent-pill",
    );
  });

  it("says nothing of the kind when the share's own audio is going out", () => {
    expect(streamAudioState(stream({ hasAudio: true }))).toBe("screen");
    expect(markup({ hasAudio: true })).not.toContain(
      "watch-party-tx-silent-pill",
    );
  });

  /**
   * The false-alarm case, and the reason `hasAudio` is optional rather than
   * defaulted. A server that predates the field, and a session this process
   * adopted across a deploy (the row carries the video track sid and not the
   * audio one), both answer "not stated". Warning there would put "your film
   * is silent" in front of a host whose film is playing fine, which teaches
   * them to ignore the warning that matters.
   */
  it("warns about nothing when the server did not state it", () => {
    expect(streamAudioState(stream())).toBe("unknown");
    expect(markup({})).not.toContain("watch-party-tx-silent-pill");
    expect(streamAudioState(null)).toBe("unknown");
    expect(markup(null)).not.toContain("watch-party-tx-silent-pill");
  });
});

/**
 * The host's stream-quality selector. The panel hides it behind a click the
 * static renderer cannot make, so the control is exercised on its own. It
 * offers exactly the two choices and defaults to 720p (storage is unavailable
 * in `node`, which is the same safe default).
 */
describe("StreamQualityControl", () => {
  it("renders the label, both choices, and defaults to 720p", () => {
    const html = renderToStaticMarkup(<StreamQualityControl />);
    expect(html).toContain("Stream quality");
    expect(html).toContain("watch-party-tx-stream-quality-select");
    expect(html).toContain(">720p (recommended)<");
    expect(html).toContain(">1080p<");
    // The default is selected, so a host who does nothing publishes 720.
    expect(html).toMatch(/value="720p"[^>]*selected/);
  });
});

/**
 * The stream's mixer. Same shape as `StreamQualityControl` above: rendered
 * on its own since the panel hides it behind a click, and it defaults from
 * storage that is unavailable in `node`.
 */
describe("StreamMixControl", () => {
  it("renders both sliders at their defaults, in dB", () => {
    const html = renderToStaticMarkup(<StreamMixControl />);
    expect(html).toContain("watch-party-tx-mixer-reset");
    expect(html).toContain("watch-party-tx-mic-gain-slider");
    expect(html).toContain("watch-party-tx-display-gain-slider");
    // Defaults: +6.0 dB mic, -3.1 dB display — the same mix as before this
    // control existed.
    expect(html).toContain("+6.0 dB");
    expect(html).toContain("-3.1 dB");
  });

  it("draws an empty meter when nothing is mixed yet", () => {
    const html = renderToStaticMarkup(<StreamMixControl />);
    expect(html).toContain("watch-party-tx-mic-level");
    expect(html).toMatch(/watch-party-tx-mic-level[\s\S]*?width:\s*0%/);
  });
});
