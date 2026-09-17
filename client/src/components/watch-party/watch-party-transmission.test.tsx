import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LiveHlsStream } from "@pqp/shared";
import {
  cameraLiveOnStream,
  streamAudioState,
  StreamMixControl,
  StreamMixSummary,
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

/**
 * The mixer's stand-in inside the transmission details (2026-09-13): the
 * two levels as set, and the door to the dialog that owns the sliders.
 */
describe("StreamMixSummary", () => {
  it("reads both levels and offers Ajustar, with no slider of its own", () => {
    const html = renderToStaticMarkup(<StreamMixSummary onOpen={() => {}} />);
    expect(html).toContain("watch-party-tx-mixer-summary");
    expect(html).toContain("watch-party-tx-mixer-open");
    expect(html).toContain("+6.0 dB");
    expect(html).toContain("-3.1 dB");
    expect(html).not.toContain("watch-party-tx-mic-gain-slider");
  });
});

/**
 * THE INCIDENT (2026-09-16). The presenter's own screen publish dropped after
 * an API-restart reconnect. The server still called the party live and the
 * HLS stream lingered, so a health keyed on `stream` alone kept saying "ok"
 * with an uptime ticking up over a dead broadcast for 35 minutes. `recovering`
 * is the presenter's truthful signal and it must win over the stale stream.
 */
describe("the presenter's own publish dropping (recovering)", () => {
  function detailed(recovering: boolean) {
    return renderToStaticMarkup(
      <WatchPartyTransmission
        stream={stream({})}
        wentLiveAt="2026-09-09T12:00:00.000Z"
        audienceCount={137}
        isPresenting
        recovering={recovering}
        quality="auto"
        roomViewers={4}
        transport="livekit"
        detailsInDialog
        now={new Date("2026-09-09T12:20:00.000Z")}
      />,
    );
  }

  it("says the stream dropped instead of counting uptime over a live stream", () => {
    const html = detailed(true);
    expect(html).toContain("Your stream dropped. Reconnecting");
    // Not the healthy summary, and not the 20-minute uptime it would otherwise
    // show for a stream that started at 12:00 and a clock at 12:20.
    expect(html).not.toContain("20 min");
    expect(html).toContain('aria-label="Reconnecting your stream"');
  });

  it("marks the health bad even though the server still reports a live stream", () => {
    // The dot is `bg-danger` only for the bad state; a live stream with no
    // fault would be `bg-success`.
    const html = detailed(true);
    const dot = html.slice(html.indexOf("watch-party-tx-health"));
    expect(dot).toContain("bg-danger");
  });

  it("leaves the uptime running when the publish is healthy", () => {
    // The control case: same live stream, not recovering -> the 20-minute
    // uptime is present, proving the freeze above is `recovering`'s doing.
    expect(detailed(false)).toContain("20 min");
  });
});

/**
 * THE LOW-LATENCY PATH NEVER REACHES THE LIVE WORDING (staging, 2026-09-18).
 * The summary's live branch is gated on `stream.topHeight`, the tallest rung
 * the LiveKit egress ladder actually started -- but `mode: "ll"` sessions
 * (`pqp-remux`, no transcode) have no ladder and never set `topHeight`, so
 * the header reads "Preparing the broadcast" for the whole party even though
 * the room is live, viewers are watching and the sidebar's AO VIVO pill
 * already agrees. Same shape as pitfall 9/12: a signal that only ever meant
 * one delivery mode was read as if it covered both.
 */
describe("the low-latency path (mode: \"ll\") reaching the live wording", () => {
  it("says how many are watching instead of freezing on 'preparing'", () => {
    const html = markup({ mode: "ll", topHeight: undefined });
    expect(html).toContain("137 watching");
    expect(html).not.toContain("Preparing the broadcast");
  });

  it("still says nobody is watching yet, without freezing on 'preparing'", () => {
    const html = renderToStaticMarkup(
      <WatchPartyTransmission
        stream={stream({ mode: "ll", topHeight: undefined })}
        wentLiveAt="2026-09-09T12:00:00.000Z"
        audienceCount={0}
        isPresenting
        quality="auto"
        roomViewers={4}
        transport="livekit"
        now={new Date("2026-09-09T12:20:00.000Z")}
      />,
    );
    expect(html).toContain("nobody watching yet");
    expect(html).not.toContain("Preparing the broadcast");
  });
});
