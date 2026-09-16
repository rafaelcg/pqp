import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { MusicResolved, MusicState, MusicTrack } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { VoiceState } from "@/hooks/use-voice";
import {
  addTrack,
  getMusicSnapshot,
  receiveMusic,
  resetMusicStoreForTests,
  setListening,
  setMusicOpen,
  setMusicSession,
  stopMusic,
} from "@/lib/music-store";
import { resetMusicPrefsForTests } from "@/lib/music-prefs";
import { ChannelMusicCard } from "@/components/voice/channel-music-card";
import { MusicMiniPlayer } from "@/components/voice/music-mini-player";
import { effectiveCanManageMusic, musicOverflowItems } from "@/components/voice/music-extras";
import { translateMessage } from "@/lib/i18n";
import { MusicPanel, musicActivityForViewer, musicActivityFromDiff } from "@/components/voice/music-panel";
import {
  insertMusicStageTile,
  MUSIC_STAGE_TILE_ID,
} from "@/components/voice/music-stage-tile";
import { formatMusicClockOrUnknown, MusicNowPlaying } from "@/components/voice/music-now-playing";
import { MusicDock } from "@/components/voice/music-dock";
import {
  musicEmbedCommand,
  playerNeedsRoomSeek,
  shouldKeepMusicEmbed,
  shouldReportUnknownDuration,
} from "@/components/voice/music-player-embed";
import { resetMusicEmbedHostForTests } from "@/components/voice/music-embed-host";
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
  openControls: false,
  repeat: "off",
  skipVotes: [],
  history: [],
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
    sharePublishRecovering: false,
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

  it("does not announce the local peer's own actions", () => {
    const playing = state({ actorId: "peer-me" });
    expect(musicActivityForViewer(playing, state({ actorId: "peer-me", status: "paused" }), "peer-me")).toBeNull();
    expect(musicActivityForViewer(playing, state({ actorId: "peer-rafa", status: "paused" }), "peer-me")).toEqual({
      kind: "paused",
    });
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

describe("playerNeedsRoomSeek", () => {
  it("jumps a playing embed after a seek, including the writer", () => {
    expect(playerNeedsRoomSeek(10_000, 90_000)).toBe(true);
    expect(playerNeedsRoomSeek(90_100, 90_000)).toBe(false);
  });
});

describe("musicEmbedCommand", () => {
  it("stops the iframe when the room has no current track", () => {
    expect(musicEmbedCommand(null, "playing")).toBe("stop");
    expect(musicEmbedCommand("", "paused")).toBe("stop");
  });

  it("loads a playing track and cues a paused one", () => {
    expect(musicEmbedCommand("dQw4w9WgXcQ", "playing")).toBe("load");
    expect(musicEmbedCommand("dQw4w9WgXcQ", "paused")).toBe("cue");
  });
});

describe("shouldKeepMusicEmbed", () => {
  it("holds the iframe after the queue is cleared, and drops it when listening stops", () => {
    expect(
      shouldKeepMusicEmbed({
        inCall: true,
        listening: true,
        hasCurrent: false,
        previouslyHeld: false,
      }),
    ).toBe(false);
    expect(
      shouldKeepMusicEmbed({
        inCall: true,
        listening: true,
        hasCurrent: true,
        previouslyHeld: false,
      }),
    ).toBe(true);
    expect(
      shouldKeepMusicEmbed({
        inCall: true,
        listening: true,
        hasCurrent: false,
        previouslyHeld: true,
      }),
    ).toBe(true);
    expect(
      shouldKeepMusicEmbed({
        inCall: true,
        listening: false,
        hasCurrent: true,
        previouslyHeld: true,
      }),
    ).toBe(false);
    expect(
      shouldKeepMusicEmbed({
        inCall: false,
        listening: true,
        hasCurrent: true,
        previouslyHeld: true,
      }),
    ).toBe(false);
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

describe("musicOverflowItems", () => {
  const t = (key: Parameters<typeof translateMessage>[0]) => translateMessage(key);

  it("puts duck, video, stage, room options and stop for everyone on a manager menu", () => {
    const items = musicOverflowItems({
      t,
      canManage: true,
      ducking: true,
      showVideo: false,
      onStage: false,
      openControls: false,
      autoplay: true,
      onToggleDucking: () => {},
      onToggleVideo: () => {},
      onWatchOnStage: () => {},
      onStopAll: () => {},
    });
    expect(items.map((item) => item.id)).toEqual([
      "duck",
      "video",
      "stage",
      "sep-room",
      "open-controls",
      "autoplay",
      "sep-stop",
      "stop-all",
    ]);
    expect(items.find((item) => item.id === "autoplay")?.checked).toBe(true);
    expect(items.find((item) => item.id === "stop-all")?.danger).toBe(true);
    expect(items.filter((item) => !item.separator).every((item) => item.icon)).toBe(true);
  });

  it("drops manage-only rows when the viewer cannot manage", () => {
    const items = musicOverflowItems({
      t,
      canManage: false,
      ducking: false,
      showVideo: true,
      onStage: false,
      openControls: false,
      autoplay: false,
      onToggleDucking: () => {},
      onToggleVideo: () => {},
    });
    expect(items.map((item) => item.id)).toEqual(["duck", "video"]);
    expect(items.find((item) => item.id === "video")?.checked).toBe(true);
  });
});

describe("effectiveCanManageMusic", () => {
  it("promotes a speaker when everyone controls is on", () => {
    expect(
      effectiveCanManageMusic({ canManageMusic: false, canSpeak: true }, { openControls: true }),
    ).toBe(true);
    expect(
      effectiveCanManageMusic({ canManageMusic: false, canSpeak: true }, { openControls: false }),
    ).toBe(false);
    expect(
      effectiveCanManageMusic({ canManageMusic: false, canSpeak: false }, { openControls: true }),
    ).toBe(false);
    expect(effectiveCanManageMusic({ canManageMusic: true, canSpeak: false }, null)).toBe(true);
  });
});

describe("MusicNowPlaying", () => {
  it("shows the adder and a vote skip when the viewer cannot manage", () => {
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
    expect(html).toContain("data-music-expand");
    expect(html).not.toContain("data-music-expand-label");
    expect(html).toContain("data-music-vote-skip");
    expect(html).toContain("data-music-stop-listening");
    expect(html).toContain("opacity-40");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("h-10 w-10");
    expect(html.match(/aria-expanded/g)?.length).toBe(3);
  });

  it("says the room picked a similar track", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          current={track("now", { autoplayed: true })}
          music={{
            channelId: CHANNEL,
            state: state({ current: track("now", { autoplayed: true }) }),
            receivedAt: Date.now(),
            open: false,
            listening: true,
          }}
          voiceState={voiceState()}
          canManage
          playing
          needsTap={false}
          onExpand={() => {}}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-autoplayed");
    expect(html).not.toContain("Ana");
    expect(html).toContain("data-slider=\"edge\"");
  });
});

describe("MusicDock", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      send: () => {},
    });
  });

  it("lets the compact title use leftover width instead of a 12rem cap", () => {
    receiveMusic(
      CHANNEL,
      state({ current: track("now", { title: "Arctic Monkeys - Cornerstone" }) }),
    );
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicDock compact voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-dock=\"compact\"");
    expect(html).toContain("Arctic Monkeys - Cornerstone");
    expect(html).not.toContain("max-w-[12rem]");
    expect(html).toContain("flex-1");
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
    expect(html).toContain("data-music-collapse");
    expect(html).toContain("data-music-overflow");
    expect(html).toContain("data-music-stop-listening");
    expect(html).not.toContain("data-music-collapse-label");
    expect(html).not.toContain("grid-cols-2");
    expect(html).toContain("h-14 w-14");
    expect(html).not.toContain("aspect-square");
    expect(html).toContain("data-slider=\"scrub\"");
    expect(html).toContain("data-indeterminate");
    expect(html).toContain("–:––");
    expect(html).toMatch(/0:00[\s\S]*data-slider="scrub"[\s\S]*–:––/);
  });

  it("lets a manager seek once duration is known", () => {
    const html = renderPanel(180_000);
    expect(html).toContain("data-slider=\"scrub\"");
    expect(html).not.toContain("data-indeterminate");
    expect(html).toMatch(/0:00[\s\S]*data-slider="scrub"[\s\S]*3:00/);
  });

  it("puts repeat, shuffle and an overflow trigger on a manager panel", () => {
    const html = renderPanel(180_000);
    expect(html).toContain("data-music-repeat");
    expect(html).toContain("data-music-shuffle");
    expect(html).toContain("data-music-overflow");
    expect(html).not.toContain("data-music-options");
    expect(html).toContain("data-music-listeners");
    expect(html).toContain("data-slider=\"volume\"");
  });

  it("replaces skip with vote skip when the viewer cannot manage", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicPanel
          current={track("now")}
          music={snapshot(180_000)}
          voiceState={voiceState({ canManageMusic: false })}
          canManage={false}
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
    expect(html).toContain("data-music-vote-skip");
    expect(html).toContain("data-music-overflow");
    expect(html).not.toContain("data-music-options");
    expect(html).not.toContain("data-music-repeat");
    expect(html).not.toContain("grid-cols-1");
  });

  it("keeps stage and ducking off the sheet body", () => {
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
    expect(html).toContain("data-music-overflow");
    expect(html).not.toContain("role=\"switch\"");
  });
});

describe("ChannelMusicCard", () => {
  it("offers Ouvir when the viewer is outside the call", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ChannelMusicCard
          channelId={CHANNEL}
          track={{ videoId: "aaaaaaaaaaa", title: "Legião", thumbnailUrl: null, listeners: 3 }}
          inCall={false}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("data-channel-music");
    expect(html).toContain("Legião");
    expect(html).toContain("3");
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
    resetMusicEmbedHostForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      send: () => {},
    });
  });

  it("offers Tocar música in the sidebar when nothing is playing", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain('data-music-mini-player="idle"');
    expect(html).toContain("data-music-embed-dock");
    expect(html).toMatch(/Play music|Tocar música|music\.bar\.start/);
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
    expect(html).toContain("data-music-embed-dock");
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
    expect(html).toContain("data-music-embed-dock");
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

  it("shows the compact bar when a room is already playing", () => {
    receiveMusic(CHANNEL, state({ current: track("now", { title: "Legião Urbana" }) }));
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-now-playing");
    expect(html).toContain("data-music-expand");
    expect(html).toContain("data-music-stop-listening");
    expect(html).not.toContain("data-music-panel");
    expect(html).not.toContain("data-music-expand-label");
  });

  it("opens the sheet when this machine adds a song", () => {
    addTrack({
      provider: "youtube",
      videoId: "aaaaaaaaaaa",
      title: "Legião Urbana",
      sourceUrl: null,
      thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
      durationMs: 1,
    });
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-panel");
    expect(html).toContain("data-music-overflow");
    expect(html).toContain("data-music-stop-listening");
    expect(html).not.toContain("data-music-now-playing");
  });

  it("keeps the embed dock after the room stop so a second queue can play", () => {
    addTrack({
      provider: "youtube",
      videoId: "aaaaaaaaaaa",
      title: "Legião Urbana",
      sourceUrl: null,
      thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
      durationMs: 1,
    });
    stopMusic();
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toMatch(/data-music-mini-player="(idle|start)"/);
    expect(html).toContain("data-music-embed-dock");
    expect(html).not.toContain("data-music-now-playing");
  });
});
