import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LiveHlsStream } from "@pqp/shared";
import {
  showsCameraHeldHint,
  streamAudioState,
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

describe("what the host is told about their own camera", () => {
  it("states the 360p hold exactly while the cap is in force", () => {
    // The cap lands when this machine's share is what the egress transcodes
    // (`effectiveCameraQuality`, applied from `use-voice.ts`). Saying it any
    // earlier reads as a setting somebody changed behind their back.
    expect(showsCameraHeldHint(true, stream())).toBe(true);
  });

  it("says nothing while the broadcast is still preparing", () => {
    expect(showsCameraHeldHint(true, null)).toBe(false);
  });

  it("says nothing to a host who is not the one presenting", () => {
    expect(showsCameraHeldHint(false, stream())).toBe(false);
  });
});
