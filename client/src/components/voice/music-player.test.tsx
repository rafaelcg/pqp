import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { MusicResolved, MusicState, MusicTrack } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { VoiceState } from "@/hooks/use-voice";
import {
  addTrack,
  getMusicSnapshot,
  resetMusicStoreForTests,
  setListening,
  setMusicOpen,
  setMusicSession,
} from "@/lib/music-store";
import { resetMusicPrefsForTests } from "@/lib/music-prefs";
import { ChannelMusicCard } from "@/components/voice/channel-music-card";
import { MusicBarButton } from "@/components/voice/music-bar-button";
import { MusicMiniPlayer } from "@/components/voice/music-mini-player";
import { MusicPanel, musicActivityFromDiff } from "@/components/voice/music-panel";
import {
  insertMusicStageTile,
  MUSIC_STAGE_TILE_ID,
} from "@/components/voice/music-stage-tile";
import { formatMusicClockOrUnknown, MusicNowPlaying } from "@/components/voice/music-now-playing";
import { shouldReportUnknownDuration } from "@/components/voice/music-player-embed";
import {
  queueResolvedNext,
  shouldResolveQuery,
} from "@/components/voice/music-search-picker";
import { trackSourceHref, trackSourceIsSpotify } from "@/components/voice/music-queue-list";

const CHANNEL = "11111111-1111-4111-8111-111111111111";

const track = (id: string, extra: Partial<MusicTrack> = {}): MusicTrack => ({
  id,
  provider: "youtube",
  videoId: id.padEnd(11, "a").slice(0, 11),
  title: `Track ${id}`,
  sourceUrl: null,
  thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
  durationMs: 180_000,
  addedByUserId: "22222222-2222-4222-8222-222222222222",
  addedByName: "Ana",
  ...extra,
});

const state = (partial: Partial<MusicState> = {}): MusicState => ({
  current: track("now"),
  queue: [],
  status: "playing",
  positionMs: 0,
  atMs: 1,
  rev: 1,
  actorId: "peer-ana",
  ...partial,
});

const voiceState = (overrides: Partial<VoiceState> = {}): VoiceState =>
  ({
    status: "connected",
    peerId: "peer-me",
    remotePeers: [],
    uplinkBps: null,
    isMuted: false,
    isDeafened: false,
    canSpeak: true,
    canStream: true,
    canManageMusic: true,
    isAudienceSeat: false,
    inputMode: "voice-activity",
    isTransmitting: false,
    error: null,
    errorKind: null,
    notice: null,
    micFallback: null,
    voiceChannelId: CHANNEL,
    self: {
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      avatarUrl: null,
    },
    speakingPeerIds: [],
    serverMutedPeerIds: [],
    handRaisedAt: null,
    occupancy: {
      [CHANNEL]: [
        {
          peerId: "peer-ana",
          userId: "22222222-2222-4222-8222-222222222222",
          displayName: "Ana",
          avatarUrl: null,
        },
      ],
    },
    peerVolumes: {},
    screenVolumes: {},
    usingSfu: false,
    transportFailure: null,
    roomTransport: "mesh",
    canPromoteTransport: false,
    capacityRoseFrom: null,
    isSharingScreen: false,
    isSharingMic: false,
    micInStream: true,
    voiceTrackMode: "junto",
    screenSharePeerIds: [],
    cameraPeerIds: [],
    focusedScreenPeerId: null,
    dismissedSharePeerIds: [],
    audibleScreenPeerIds: [],
    localScreenStream: null,
    isSharingScreenAudio: false,
    isSharingSystemAudio: false,
    isShareCursorVisible: false,
    screenShareAudioFailed: false,
    incomingCalls: [],
    isCameraOn: false,
    localCameraStream: null,
    callDeclinedUserIds: [],
    liveStream: null,
    channelLive: {},
    channelMusic: {},
    ...overrides,
  }) as VoiceState;

describe("musicActivityFromDiff", () => {
  it("stays quiet on the first snapshot", () => {
    expect(musicActivityFromDiff(null, state())).toBeNull();
  });

  it("names a skip, a pause and a multi-add", () => {
    const playing = state();
    expect(musicActivityFromDiff(playing, state({ current: track("next"), actorId: "peer-rafa" }))).toEqual({
      kind: "skipped",
    });
    expect(musicActivityFromDiff(playing, state({ status: "paused" }))).toEqual({ kind: "paused" });
    expect(
      musicActivityFromDiff(
        playing,
        state({ queue: [track("a"), track("b"), track("c")] }),
      ),
    ).toEqual({ kind: "added", count: 3 });
  });

  it("treats a torn-down room as stopped", () => {
    expect(musicActivityFromDiff(state(), null)).toEqual({ kind: "stopped" });
  });
});

describe("shouldResolveQuery", () => {
  it("resolves links and searches everything else", () => {
    expect(shouldResolveQuery("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(shouldResolveQuery("spotify:track:4uLU6hMCjMI75M1A2tKUQC")).toBe(true);
    expect(shouldResolveQuery("legia urbana tempo perdido")).toBe(false);
  });
});

describe("queueResolvedNext", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-a",
      userId: "u1",
      displayName: "Ana",
      send: () => {},
    });
  });

  it("starts the first track and inserts the next at the front", () => {
    const first: MusicResolved = {
      provider: "youtube",
      videoId: "aaaaaaaaaaa",
      title: "First",
      sourceUrl: null,
      thumbnailUrl: null,
      durationMs: 1,
    };
    const second: MusicResolved = { ...first, videoId: "bbbbbbbbbbb", title: "Second" };
    expect(addTrack(first)).toBe("playing");
    expect(queueResolvedNext(second)).toBe("queued");
    expect(getMusicSnapshot().state?.queue.map((item) => item.videoId)).toEqual(["bbbbbbbbbbb"]);
  });
});

describe("track source link", () => {
  it("prefers Spotify when the resolve kept that URL", () => {
    const spotify = track("s", { sourceUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC" });
    expect(trackSourceIsSpotify(spotify)).toBe(true);
    expect(trackSourceHref(track("y"))).toBe(
      `https://www.youtube.com/watch?v=${track("y").videoId}`,
    );
  });
});

describe("formatMusicClockOrUnknown", () => {
  it("draws a dash clock when duration is missing", () => {
    expect(formatMusicClockOrUnknown(null)).toBe("–:––");
    expect(formatMusicClockOrUnknown(0)).toBe("–:––");
    expect(formatMusicClockOrUnknown(65_000)).toBe("1:05");
  });
});

describe("shouldReportUnknownDuration", () => {
  it("fires once per track for the actor while duration is empty", () => {
    expect(
      shouldReportUnknownDuration({
        isActor: true,
        trackId: "t1",
        durationMs: null,
        reportedTrackId: null,
      }),
    ).toBe(true);
    expect(
      shouldReportUnknownDuration({
        isActor: true,
        trackId: "t1",
        durationMs: null,
        reportedTrackId: "t1",
      }),
    ).toBe(false);
    expect(
      shouldReportUnknownDuration({
        isActor: true,
        trackId: "t1",
        durationMs: 180_000,
        reportedTrackId: null,
      }),
    ).toBe(false);
    expect(
      shouldReportUnknownDuration({
        isActor: false,
        trackId: "t1",
        durationMs: null,
        reportedTrackId: null,
      }),
    ).toBe(false);
  });
});

describe("MusicNowPlaying", () => {
  it("shows the adder and dims skip when the viewer cannot manage", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          current={track("now")}
          music={{
            channelId: CHANNEL,
            state: state(),
            receivedAt: Date.now(),
            open: false,
            listening: true,
          }}
          voiceState={voiceState({ canManageMusic: false })}
          canManage={false}
          playing
          needsTap={false}
          onExpand={() => {}}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("Ana");
    expect(html).toContain("data-music-now-playing");
    expect(html).toContain("opacity-40");
    expect(html).toContain("role=\"progressbar\"");
    expect(html.match(/aria-expanded/g)?.length).toBe(2);
  });
});

describe("MusicPanel", () => {
  const snapshot = (durationMs: number | null) => ({
    channelId: CHANNEL,
    state: state({ current: track("now", { durationMs }) }),
    receivedAt: Date.now(),
    open: true,
    listening: true,
  });

  const renderPanel = (durationMs: number | null) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <MusicPanel
          current={track("now", { durationMs })}
          music={snapshot(durationMs)}
          voiceState={voiceState()}
          canManage
          playing
          needsTap={false}
          showVideo={false}
          volume={40}
          muted={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          onMute={() => {}}
          onVolume={() => {}}
          onToggleVideo={() => {}}
        />
      </TooltipProvider>,
    );

  it("keeps a compact artwork row and a scrubber while duration is unknown", () => {
    const html = renderPanel(null);
    expect(html).toContain("data-music-panel");
    expect(html).toContain("h-14 w-14");
    expect(html).not.toContain("aspect-square");
    expect(html).toContain("data-slider=\"scrub\"");
    expect(html).toContain("data-indeterminate");
    expect(html).toContain("–:––");
  });

  it("lets a manager seek once duration is known", () => {
    const html = renderPanel(180_000);
    expect(html).toContain("data-slider=\"scrub\"");
    expect(html).not.toContain("data-indeterminate");
  });

  it("names the stage and ducking controls", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicPanel
          current={track("now")}
          music={snapshot(180_000)}
          voiceState={voiceState()}
          canManage
          playing
          needsTap={false}
          showVideo={false}
          volume={40}
          muted={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          onMute={() => {}}
          onVolume={() => {}}
          onToggleVideo={() => {}}
          onWatchOnStage={() => {}}
          onToggleDucking={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("role=\"switch\"");
  });
});

describe("ChannelMusicCard", () => {
  it("offers Ouvir when the viewer is outside the call", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ChannelMusicCard
          channelId={CHANNEL}
          track={{ videoId: "aaaaaaaaaaa", title: "Legião", thumbnailUrl: null }}
          inCall={false}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("data-channel-music");
    expect(html).toContain("Legião");
  });
});

describe("insertMusicStageTile", () => {
  it("takes the featured slot when nothing else is featured", () => {
    const tiles = [{ id: "cam-1" }];
    const staged = insertMusicStageTile(tiles, false, true);
    expect(staged.tiles[0]).toEqual({ kind: "music", id: MUSIC_STAGE_TILE_ID });
    expect(staged.featured).toBe(true);
    expect(staged.tiles.map((tile) => tile.id)).toEqual([MUSIC_STAGE_TILE_ID, "cam-1"]);
  });

  it("sits in the grid when something is already featured", () => {
    const tiles = [{ id: "share-1" }, { id: "cam-1" }];
    const staged = insertMusicStageTile(tiles, true, true);
    expect(staged.tiles.map((tile) => tile.id)).toEqual([
      "share-1",
      MUSIC_STAGE_TILE_ID,
      "cam-1",
    ]);
    expect(staged.featured).toBe(true);
  });
});

describe("MusicMiniPlayer", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
    resetMusicPrefsForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      send: () => {},
    });
  });

  it("draws nothing in the footer when nothing is playing", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toBe("");
  });

  it("opens the add box when the panel is open and nothing is on", () => {
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain('data-music-mini-player="start"');
    expect(html).toContain("data-music-search");
    expect(html).not.toContain('data-music-mini-player="empty"');
  });

  it("still opens the add box in the icons-only sidebar", () => {
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} compact />
      </TooltipProvider>,
    );
    expect(html).toContain('data-music-mini-player="start"');
    expect(html).toContain("data-music-search");
  });

  it("tidies the pill when the viewer is not listening", () => {
    addTrack({
      provider: "youtube",
      videoId: "aaaaaaaaaaa",
      title: "Legião Urbana",
      sourceUrl: null,
      thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
      durationMs: 1,
    });
    setListening(false);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain('data-music-mini-player="dismissed"');
    expect(html).toContain("h-5 w-5");
    expect(html).toContain("Legião Urbana");
  });
});

describe("MusicBarButton", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
  });

  it("renders the start control when nothing is on", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicBarButton size="h-9 w-9" iconSize="h-4 w-4" />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-bar-button");
    expect(html).not.toContain("data-music-eq");
  });

  it("draws the equaliser while the room is playing", () => {
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-a",
      userId: "u1",
      displayName: "Ana",
      send: () => {},
    });
    addTrack({
      provider: "youtube",
      videoId: "aaaaaaaaaaa",
      title: "Now",
      sourceUrl: null,
      thumbnailUrl: null,
      durationMs: 1,
    });
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicBarButton size="h-9 w-9" iconSize="h-4 w-4" />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-eq");
  });
});
