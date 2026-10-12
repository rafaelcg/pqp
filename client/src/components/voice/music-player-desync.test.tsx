// @vitest-environment jsdom
import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicState } from "@pqp/shared";
import {
  MusicPlayer,
  pausedRoomMaySeek,
  silencePlayerCommand,
} from "./music-player-embed";
import { resetMusicEmbedHostForTests } from "./music-embed-host";
import type { MusicSnapshot } from "@/lib/music-store";
import { YT_STATE, type YTPlayer } from "@/lib/youtube-iframe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * PQP-69: THE BAR SAID NOTHING WAS ON AND THE SONG KEPT PLAYING.
 *
 * Reproduced in a real browser with two seats: 10 s into a song the owner
 * pressed "Parar pra todos", and the other seat's player started the same
 * song again from zero with no bar on screen, for as long as anybody
 * listened. The same happened to a seat whose socket dropped while the
 * music was stopped, on its way back in.
 *
 * The fake below keeps the two properties of the real IFrame API that the
 * bug needs. Commands travel to the iframe over postMessage, so they apply
 * in order but later, and every getter answers from the last state the
 * iframe reported. And `seekTo` plays from every state but PAUSED.
 */

class FakePlayer {
  state: number = YT_STATE.UNSTARTED;
  time = 0;
  videoId: string | undefined;
  private queue: Array<() => void> = [];
  private events: {
    onReady?: (event: { target: YTPlayer }) => void;
    onStateChange?: (event: { data: number; target: YTPlayer }) => void;
  };

  constructor(
    _el: HTMLElement,
    options: {
      videoId?: string;
      events?: FakePlayer["events"];
    },
  ) {
    this.videoId = options.videoId;
    this.events = options.events ?? {};
    players.push(this);
    queueMicrotask(() => this.events.onReady?.({ target: this.api() }));
  }

  /** YouTube reports a state of its own accord, as the iframe does. */
  report(state: number): void {
    this.state = state;
    this.events.onStateChange?.({ data: state, target: this.api() });
  }

  /** Deliver every queued command, in the order it was sent. */
  flush(): void {
    const pending = this.queue;
    this.queue = [];
    for (const command of pending) {
      command();
    }
  }

  private send(command: () => void): void {
    this.queue.push(command);
  }

  api(): YTPlayer {
    return {
      loadVideoById: (id: string, start = 0) =>
        this.send(() => {
          this.videoId = id;
          this.time = start;
          this.report(YT_STATE.PLAYING);
        }),
      cueVideoById: (id: string, start = 0) =>
        this.send(() => {
          this.videoId = id;
          this.time = start;
          this.report(YT_STATE.CUED);
        }),
      playVideo: () => this.send(() => this.report(YT_STATE.PLAYING)),
      pauseVideo: () =>
        this.send(() => {
          if (this.state === YT_STATE.PLAYING || this.state === YT_STATE.BUFFERING) {
            this.report(YT_STATE.PAUSED);
          }
        }),
      stopVideo: () =>
        this.send(() => {
          this.time = 0;
          this.report(YT_STATE.CUED);
        }),
      seekTo: (seconds: number) =>
        this.send(() => {
          this.time = seconds;
          if (this.state !== YT_STATE.PAUSED && this.state !== YT_STATE.PLAYING) {
            this.report(YT_STATE.PLAYING);
          }
        }),
      getCurrentTime: () => this.time,
      getDuration: () => 213,
      getPlayerState: () => this.state,
      setVolume: () => {},
      getVolume: () => 40,
      mute: () => {},
      unMute: () => {},
      isMuted: () => false,
      getVideoData: () => ({ video_id: this.videoId }),
      destroy: () => {},
    };
  }
}

let players: FakePlayer[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;

const TRACK = {
  id: "track-a",
  provider: "youtube" as const,
  videoId: "dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  sourceUrl: null,
  thumbnailUrl: null,
  durationMs: 213_000,
  addedByUserId: "owner",
  addedByName: "Owner",
};

function roomState(overrides: Partial<MusicState> = {}): MusicState {
  return {
    current: TRACK,
    queue: [],
    status: "playing",
    positionMs: 0,
    atMs: Date.now(),
    rev: 1,
    actorId: "owner-peer",
    openControls: false,
    repeat: "off",
    skipVotes: [],
    history: [],
    autoplay: false,
    ...overrides,
  };
}

/** Every frame the store takes is stamped on arrival, so no two share one. */
function snapshot(state: MusicState | null): MusicSnapshot {
  vi.advanceTimersByTime(1);
  return {
    channelId: "voice-1",
    state,
    receivedAt: Date.now(),
    open: false,
    listening: true,
    parked: null,
  };
}

const playerRef: MutableRefObject<YTPlayer | null> = { current: null };

async function render(music: MusicSnapshot): Promise<void> {
  await act(async () => {
    root!.render(
      <MusicPlayer
        music={music}
        isActor={false}
        volume={40}
        playerRef={playerRef}
        onNeedsTap={() => {}}
      />,
    );
  });
}

/** Let the iframe answer everything the page has sent it so far. */
async function iframeCatchesUp(): Promise<void> {
  await act(async () => {
    for (const player of players) {
      player.flush();
    }
  });
}

/** A listener 10 s into the song, with the room's clock agreeing. */
async function listeningTenSecondsIn(): Promise<FakePlayer> {
  await render(snapshot(roomState()));
  await iframeCatchesUp();
  const player = players[0]!;
  expect(player.state).toBe(YT_STATE.PLAYING);
  vi.advanceTimersByTime(10_000);
  player.time = 10;
  await render(snapshot(roomState({ positionMs: 10_000, rev: 2 })));
  await iframeCatchesUp();
  expect(player.state).toBe(YT_STATE.PLAYING);
  return player;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
  players = [];
  playerRef.current = null;
  (window as unknown as { YT: unknown }).YT = { Player: FakePlayer };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetMusicEmbedHostForTests();
  delete (window as unknown as { YT?: unknown }).YT;
  vi.useRealTimers();
});

describe("the room stops while this seat is listening (PQP-69)", () => {
  it("stays silent after Parar pra todos, instead of starting the song over", async () => {
    const player = await listeningTenSecondsIn();

    // Somebody else stopped the music: the room frame is null.
    await render(snapshot(null));
    await iframeCatchesUp();

    expect(player.state).not.toBe(YT_STATE.PLAYING);
    expect(player.time).toBe(0);
  });

  it("stays silent when the queue runs dry under it", async () => {
    const player = await listeningTenSecondsIn();

    // `musicAdvance` on an empty queue: the room is still there, nothing on.
    await render(snapshot(roomState({ current: null, status: "paused", rev: 3 })));
    await iframeCatchesUp();

    expect(player.state).not.toBe(YT_STATE.PLAYING);
  });

  it("silences a player that starts on its own while nothing is on", async () => {
    const player = await listeningTenSecondsIn();
    await render(snapshot(null));
    await iframeCatchesUp();

    // A command YouTube dropped, an iframe that reloaded: it plays anyway.
    await act(async () => player.report(YT_STATE.PLAYING));
    await iframeCatchesUp();

    expect(player.state).toBe(YT_STATE.CUED);
  });

  it("puts a sounding player down on the next check even with no event", async () => {
    const player = await listeningTenSecondsIn();
    await render(snapshot(null));
    await iframeCatchesUp();

    // Sounding without telling anybody, as an iframe mid-reload can.
    player.state = YT_STATE.PLAYING;
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await iframeCatchesUp();

    expect(player.state).toBe(YT_STATE.CUED);
  });
});

describe("the room is paused while this seat is listening", () => {
  it("pauses a player that a late load starts after the pause", async () => {
    await render(snapshot(roomState()));
    const player = players[0]!;
    // Paused while the load is still in flight, then the load lands.
    await render(snapshot(roomState({ status: "paused", positionMs: 0, rev: 2 })));
    await iframeCatchesUp();
    await iframeCatchesUp();

    expect(player.state).toBe(YT_STATE.PAUSED);
  });

  it("still follows a seek while paused, without starting playback", async () => {
    const player = await listeningTenSecondsIn();
    await render(snapshot(roomState({ status: "paused", positionMs: 10_000, rev: 3 })));
    await iframeCatchesUp();
    expect(player.state).toBe(YT_STATE.PAUSED);

    await render(snapshot(roomState({ status: "paused", positionMs: 60_000, rev: 4 })));
    await iframeCatchesUp();

    expect(player.state).toBe(YT_STATE.PAUSED);
    expect(player.time).toBe(60);
  });

  it("leaves a playing room alone", async () => {
    const player = await listeningTenSecondsIn();
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    await iframeCatchesUp();
    expect(player.state).toBe(YT_STATE.PLAYING);
  });
});

describe("pausedRoomMaySeek", () => {
  it("never moves a player when the room has nothing on", () => {
    for (const playerState of Object.values(YT_STATE)) {
      expect(pausedRoomMaySeek({ roomVideoId: null, playerState })).toBe(false);
    }
  });

  it("does not seek a cued, unstarted or ended player, which seeking would start", () => {
    for (const playerState of [YT_STATE.CUED, YT_STATE.UNSTARTED, YT_STATE.ENDED]) {
      expect(pausedRoomMaySeek({ roomVideoId: "dQw4w9WgXcQ", playerState })).toBe(false);
    }
  });

  it("seeks a player the pause just before it has stopped", () => {
    for (const playerState of [YT_STATE.PAUSED, YT_STATE.PLAYING, YT_STATE.BUFFERING]) {
      expect(pausedRoomMaySeek({ roomVideoId: "dQw4w9WgXcQ", playerState })).toBe(true);
    }
  });
});

describe("silencePlayerCommand", () => {
  it("stops a sounding player when the room has nothing on", () => {
    expect(
      silencePlayerCommand({ roomVideoId: null, status: "paused", playerState: YT_STATE.PLAYING }),
    ).toBe("stop");
    expect(
      silencePlayerCommand({ roomVideoId: null, status: "playing", playerState: YT_STATE.BUFFERING }),
    ).toBe("stop");
  });

  it("pauses a sounding player in a paused room", () => {
    expect(
      silencePlayerCommand({
        roomVideoId: "dQw4w9WgXcQ",
        status: "paused",
        playerState: YT_STATE.PLAYING,
      }),
    ).toBe("pause");
  });

  it("does nothing to a playing room, or to a player that is already quiet", () => {
    expect(
      silencePlayerCommand({
        roomVideoId: "dQw4w9WgXcQ",
        status: "playing",
        playerState: YT_STATE.PLAYING,
      }),
    ).toBeNull();
    for (const playerState of [YT_STATE.CUED, YT_STATE.PAUSED, YT_STATE.ENDED, YT_STATE.UNSTARTED]) {
      expect(silencePlayerCommand({ roomVideoId: null, status: "paused", playerState })).toBeNull();
    }
  });
});
