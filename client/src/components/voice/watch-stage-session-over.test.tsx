// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { WatchChannelStage } from "./watch-stage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE PANE HAS TO GIVE THE SPACE BACK.
 *
 * On 2026-09-17 the player was left mounted on a session that had ended: the
 * holding screen kept the film's slot, so the watch party panel underneath --
 * which owns "nothing is on air" and the button that starts the next show --
 * never got it back, and the sidebar card saying "Montando. Toca pra
 * continuar." was the only thing in the app telling the truth.
 *
 * The `channel-live` frame is what normally clears this and it is not what
 * failed here; the player's own answer from the server is the second door.
 * `HlsWatchPlayer` is faked down to the one prop under test, because what is
 * being pinned is the pane's reaction, not hls.js.
 */

const playerProps = vi.hoisted(() => ({
  onSessionOver: null as ((reason: "over" | "awaiting") => void) | null,
  src: null as string | null,
}));

vi.mock("@/components/voice/hls-watch-player", () => ({
  HlsWatchPlayer: (props: {
    src: string;
    onSessionOver?: (reason: "over" | "awaiting") => void;
  }) => {
    playerProps.onSessionOver = props.onSessionOver ?? null;
    playerProps.src = props.src;
    return <div data-testid="fake-player" />;
  },
}));

const HLS_URL =
  "https://api.example.test/api/voice/hls-playlist/c1/1789672792562?t=tok";
const NEXT_HLS_URL =
  "https://api.example.test/api/voice/hls-playlist/c1/1789673999999?t=tok2";

function voiceState(
  stream: { hlsUrl: string; startedAt: number } | null,
): VoiceState {
  return {
    voiceChannelId: null,
    status: "idle",
    channelLive: {
      c1: {
        stream: stream
          ? { ...stream, presenterPeerId: "peer-1" }
          : null,
        watching: 1,
      },
    },
    occupancy: { c1: [] },
  } as unknown as VoiceState;
}

describe("WatchChannelStage when the player says the session is over", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    playerProps.onSessionOver = null;
    playerProps.src = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(stream: { hlsUrl: string; startedAt: number } | null) {
    act(() => {
      root.render(
        <WatchChannelStage
          channelId="c1"
          channelName="cinema"
          voiceState={voiceState(stream)}
          isWatchParty
          onSetWatchingLive={() => {}}
          onSeedChannelLive={() => {}}
        />,
      );
    });
  }

  it("drops the dead player so the party panel gets the pane back", () => {
    render({ hlsUrl: HLS_URL, startedAt: 1789672792562 });
    expect(container.querySelector('[data-testid="fake-player"]')).not.toBeNull();

    act(() => playerProps.onSessionOver?.("over"));

    expect(container.querySelector('[data-testid="fake-player"]')).toBeNull();
    // A watch party channel deliberately shows no ended card of its own: the
    // panel's surface owns that space, and drawing both is what used to push
    // the chat and the composer off screen.
    expect(
      container.querySelector('[data-testid="watch-channel-stage"]'),
    ).toBeNull();
  });

  it("comes back on its own for the next session, with nothing pressed", () => {
    render({ hlsUrl: HLS_URL, startedAt: 1789672792562 });
    act(() => playerProps.onSessionOver?.("over"));
    expect(container.querySelector('[data-testid="fake-player"]')).toBeNull();

    // A NEW session: a different `startedAt`, so a different key. Nothing has
    // to remember to forget the old verdict.
    render({ hlsUrl: NEXT_HLS_URL, startedAt: 1789673999999 });
    expect(container.querySelector('[data-testid="fake-player"]')).not.toBeNull();
    expect(playerProps.src).toBe(NEXT_HLS_URL);
  });

  it("keeps the same session down when a restamped token arrives for it", () => {
    // The server restamps `?t=` on every audience keyframe, so the SAME dead
    // session comes back through `channel-live` every thirty seconds. That
    // must not resurrect it: `startedAt` is what names a session.
    render({ hlsUrl: HLS_URL, startedAt: 1789672792562 });
    act(() => playerProps.onSessionOver?.("over"));
    render({ hlsUrl: `${HLS_URL}-restamped`, startedAt: 1789672792562 });
    expect(container.querySelector('[data-testid="fake-player"]')).toBeNull();
  });
});
