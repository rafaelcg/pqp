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
import { resetChannelMusicCardRightsForTests } from "@/components/voice/channel-music-card-rights";
import { MusicMiniPlayer } from "@/components/voice/music-mini-player";
import { effectiveCanManageMusic, musicOverflowItems, nextMusicRepeat } from "@/components/voice/music-extras";
import { translateMessage } from "@/lib/i18n";
import {
  formatMusicClockOrUnknown,
  musicListenerCount,
  MusicNowPlaying,
} from "@/components/voice/music-now-playing";
import {
  insertMusicStageTile,
  MUSIC_STAGE_TILE_ID,
} from "@/components/voice/music-stage-tile";
import { MusicComposer } from "@/components/voice/music-composer";
import { MusicFila } from "@/components/voice/music-fila";
import { resetMusicLocalPlaybackForTests } from "@/components/voice/music-local-playback";
import {
  applyYouTubeVolume,
  musicEmbedCommand,
  playerNeedsRoomSeek,
  shouldAdvanceOnEnded,
  shouldCallPlayVideo,
  shouldKeepMusicEmbed,
  shouldReportPositionSample,
  shouldReportUnknownDuration,
} from "@/components/voice/music-player-embed";
import { YT_STATE } from "@/lib/youtube-iframe";
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

const seat = (
  peerId: string,
  extra: Record<string, unknown> = {},
): VoiceState["occupancy"][string][number] =>
  ({
    peerId,
    userId: `user-${peerId}`,
    displayName: peerId,
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    ...extra,
  }) as VoiceState["occupancy"][string][number];

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

describe("shouldCallPlayVideo", () => {
  const base = {
    status: "playing" as const,
    roomVideoId: "aaaaaaaaaaa",
    loadedVideoId: "aaaaaaaaaaa",
    playerState: YT_STATE.PAUSED,
    repeat: "off" as const,
  };

  it("does not restart an ended video unless repeat is one", () => {
    expect(shouldCallPlayVideo({ ...base, playerState: YT_STATE.ENDED })).toBe(false);
    expect(shouldCallPlayVideo({ ...base, playerState: YT_STATE.ENDED, repeat: "one" })).toBe(true);
  });

  it("leaves a mismatched loaded video to the load effect", () => {
    expect(shouldCallPlayVideo({ ...base, loadedVideoId: "bbbbbbbbbbb" })).toBe(false);
  });

  it("does not poke a player that is already playing", () => {
    expect(shouldCallPlayVideo({ ...base, playerState: YT_STATE.PLAYING })).toBe(false);
    expect(shouldCallPlayVideo({ ...base, playerState: YT_STATE.BUFFERING })).toBe(false);
  });

  it("plays a paused or cued matching video", () => {
    expect(shouldCallPlayVideo(base)).toBe(true);
    expect(shouldCallPlayVideo({ ...base, playerState: YT_STATE.CUED })).toBe(true);
  });
});

describe("applyYouTubeVolume", () => {
  it("ducks with setVolume and never unMute", () => {
    const calls: string[] = [];
    const player = {
      setVolume: (value: number) => calls.push(`vol:${value}`),
      mute: () => calls.push("mute"),
      unMute: () => calls.push("unMute"),
    };
    applyYouTubeVolume(player, { volume: 40, muted: false, duckGain: 0.35 });
    expect(calls).toEqual(["vol:14"]);
    applyYouTubeVolume(player, { volume: 40, muted: true, duckGain: 0.35 });
    expect(calls).toEqual(["vol:14", "vol:40", "mute"]);
  });
});

describe("shouldAdvanceOnEnded", () => {
  it("ignores a missing or mismatched video id", () => {
    expect(shouldAdvanceOnEnded(undefined, "aaaaaaaaaaa")).toBe(false);
    expect(shouldAdvanceOnEnded("bbbbbbbbbbb", "aaaaaaaaaaa")).toBe(false);
    expect(shouldAdvanceOnEnded("aaaaaaaaaaa", "aaaaaaaaaaa")).toBe(true);
  });
});

describe("shouldReportPositionSample", () => {
  it("skips samples while the player is ended", () => {
    expect(shouldReportPositionSample(YT_STATE.ENDED)).toBe(false);
    expect(shouldReportPositionSample(YT_STATE.PLAYING)).toBe(true);
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

  it("puts room options, repeat, shuffle and stop on a drawer menu", () => {
    const items = musicOverflowItems({
      t,
      canManage: true,
      listening: true,
      openControls: false,
      autoplay: true,
      repeat: "off",
      onStopAll: () => {},
    });
    expect(items.map((item) => item.id)).toEqual([
      "scope-you",
      "stop-listening",
      "sep-scope",
      "scope-room",
      "open-controls",
      "autoplay",
      "repeat",
      "shuffle",
      "sep-stop",
      "stop-all",
    ]);
    expect(items.find((item) => item.id === "autoplay")?.checked).toBe(true);
    expect(items.find((item) => item.id === "stop-all")?.danger).toBe(true);
    /* Headings and separators carry no icon; every real row does. */
    expect(
      items
        .filter((item) => !item.separator && !item.heading)
        .every((item) => item.icon),
    ).toBe(true);
  });

  it("puts shuffle and repeat first on the bar menu", () => {
    const items = musicOverflowItems({
      t,
      canManage: true,
      listening: true,
      openControls: true,
      autoplay: false,
      repeat: "one",
      modes: "menu",
      onStopAll: () => {},
    });
    expect(items.map((item) => item.id)).toEqual([
      "scope-you",
      "stop-listening",
      "sep-scope",
      "scope-room",
      "shuffle",
      "repeat",
      "open-controls",
      "autoplay",
      "sep-stop",
      "stop-all",
    ]);
    expect(items.find((item) => item.id === "repeat")?.checked).toBe(true);
  });

  it("drops shuffle and repeat when the bar already shows them", () => {
    const items = musicOverflowItems({
      t,
      canManage: true,
      listening: true,
      openControls: false,
      autoplay: false,
      repeat: "off",
      modes: "none",
      onStopAll: () => {},
    });
    expect(items.map((item) => item.id)).toEqual([
      "scope-you",
      "stop-listening",
      "sep-scope",
      "scope-room",
      "open-controls",
      "autoplay",
      "sep-stop",
      "stop-all",
    ]);
  });

  /* The one stop a member has. No heading: a label over a single row is
     noise, and there is no second group to tell it apart from. */
  it("is the personal row alone when the viewer cannot manage", () => {
    const items = musicOverflowItems({
      t,
      canManage: false,
      listening: true,
      openControls: false,
      autoplay: false,
      repeat: "off",
    });
    expect(items.map((item) => item.id)).toEqual(["stop-listening"]);
    expect(items[0]?.label).toBe(translateMessage("music.dismiss"));
  });

  it("offers the way back in once this machine has stopped", () => {
    const items = musicOverflowItems({
      t,
      canManage: false,
      listening: false,
      openControls: false,
      autoplay: false,
      repeat: "off",
    });
    expect(items.map((item) => item.id)).toEqual(["listen"]);
    expect(items[0]?.label).toBe(translateMessage("music.listen"));
  });

  it("leads a manager's menu with the same personal row", () => {
    const items = musicOverflowItems({
      t,
      canManage: true,
      listening: true,
      openControls: false,
      autoplay: false,
      repeat: "off",
      modes: "menu",
      onStopAll: () => {},
    });
    const stopYou = items.findIndex((item) => item.id === "stop-listening");
    const stopAll = items.findIndex((item) => item.id === "stop-all");
    expect(stopYou).toBeGreaterThanOrEqual(0);
    expect(stopAll).toBeGreaterThan(stopYou);
    expect(items.find((item) => item.id === "scope-you")?.heading).toBe(true);
    expect(items.find((item) => item.id === "scope-room")?.heading).toBe(true);
  });

  it("cycles repeat off, one, all", () => {
    expect(nextMusicRepeat("off")).toBe("one");
    expect(nextMusicRepeat("one")).toBe("all");
    expect(nextMusicRepeat("all")).toBe("off");
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
  const extras = {
    listening: true as const,
    volume: 40,
    muted: false,
    ducking: true,
    onOpenFila: () => {},
    onMute: () => {},
    onVolume: () => {},
    onToggleDucking: () => {},
  };

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
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          {...extras}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("Ana");
    expect(html).toContain("data-music-now-playing");
    expect(html).toContain("data-music-speaker");
    expect(html).toContain("data-music-vote-skip");
    expect(html).not.toContain("data-music-stop-listening");
    expect(html).not.toContain("data-music-fila=\"\"");
    expect(html).toContain("opacity-40");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("h-8 w-8");
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
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          {...extras}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-autoplayed");
    expect(html).not.toContain("Ana");
    expect(html).toContain("data-slider=\"edge\"");
    expect(html).toContain("h-8 w-8");
    expect(html).not.toContain("h-14 w-14");
    expect(html).not.toContain("data-slider=\"scrub\"");
  });

  it("is the player on the composer bar: 56px art, round play, seek and clocks", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          tone="composer"
          current={track("now")}
          music={{
            channelId: CHANNEL,
            state: state(),
            receivedAt: Date.now(),
            open: false,
            listening: true,
          }}
          voiceState={voiceState()}
          canManage
          playing
          needsTap={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          {...extras}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('data-music-now-playing="composer"');
    expect(html).toContain("h-14 w-14");
    expect(html).toContain("rounded-full");
    expect(html).toContain("data-slider=\"scrub\"");
    expect(html).toContain("col-span-full");
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(html).toMatch(/Previous|Voltar|music\.previous/);
    expect(html).toContain("data-music-shuffle");
    expect(html).toContain("data-music-repeat");
    expect(html).toContain("data-music-overflow");
    expect(html).toContain("hidden @min-[28rem]:inline-flex");
    expect(html).not.toContain("data-music-queue-toggle");
    expect(html).toMatch(/0:00[\s\S]*data-slider="scrub"[\s\S]*3:00/);
    expect(html).not.toContain("data-slider=\"edge\"");
    /* Art, title, the overflow, the speaker, and now the up-next row. */
    expect(html.match(/aria-expanded/g)?.length).toBe(5);
  });

  it("keeps the composer seek indeterminate when duration is unknown", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          tone="composer"
          current={track("now", { durationMs: null })}
          music={{
            channelId: CHANNEL,
            state: state({ current: track("now", { durationMs: null }) }),
            receivedAt: Date.now(),
            open: false,
            listening: true,
          }}
          voiceState={voiceState()}
          canManage
          playing
          needsTap={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          {...extras}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("data-slider=\"scrub\"");
    expect(html).toContain("data-indeterminate");
    expect(html).toContain("–:––");
    expect(html).not.toContain("data-slider=\"edge\"");
  });

  it("disables skip-back when the viewer cannot manage", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          tone="composer"
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
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          {...extras}
        />
      </TooltipProvider>,
    );
    expect(html).toMatch(/Previous|Voltar|music\.previous/);
    expect(html).toContain("lucide-skip-back");
    expect(html).toContain("disabled=\"\"");
    /* Dimmed in place, not removed: see "the composer bar a member sees". */
    expect(html).toContain("data-music-shuffle");
    expect(html).toContain("data-music-repeat");
    expect(html).toContain("data-music-overflow");
  });

  it("cycles the repeat icon to Repeat1 when the mode is one", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          tone="composer"
          current={track("now")}
          music={{
            channelId: CHANNEL,
            state: state({ repeat: "one" }),
            receivedAt: Date.now(),
            open: false,
            listening: true,
          }}
          voiceState={voiceState()}
          canManage
          playing
          needsTap={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          {...extras}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('data-music-repeat="one"');
    expect(html).toContain("lucide-repeat1");
    expect(html).toContain('aria-pressed="true"');
  });
});

/** The bar states the room: what is next, and how many people are hearing it. */
describe("the composer bar's up-next line", () => {
  const knobs = {
    volume: 40,
    muted: false,
    ducking: true,
    onOpenFila: () => {},
    onMute: () => {},
    onVolume: () => {},
    onToggleDucking: () => {},
  };
  const bar = (
    music: Partial<MusicState>,
    voice: Partial<VoiceState> = {},
    listening = true,
  ) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          tone="composer"
          current={track("now")}
          music={{
            channelId: CHANNEL,
            state: state(music),
            receivedAt: Date.now(),
            open: false,
            listening,
          }}
          voiceState={voiceState(voice)}
          canManage
          playing
          needsTap={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          listening={listening}
          {...knobs}
        />
      </TooltipProvider>,
    );

  it("names the next track and counts the whole queue", () => {
    const html = bar({
      queue: [track("q1", { title: "Daft Punk - One More Time" }), track("q2"), track("q3")],
    });
    expect(html).toContain('data-music-next="track"');
    expect(html).toContain("Daft Punk - One More Time");
    expect(html).toContain("data-music-next-count");
    expect(html).toContain(translateMessage("music.next.count", { count: 3 }));
  });

  it("says the room will keep going when the queue is empty and autoplay is on", () => {
    const html = bar({ queue: [], autoplay: true });
    expect(html).toContain('data-music-next="autoplay"');
    expect(html).toContain(translateMessage("music.autoplay.next"));
    expect(html).not.toContain("data-music-next-count");
  });

  it("offers to add when the queue ran out and autoplay is off", () => {
    const html = bar({ queue: [], autoplay: false });
    expect(html).toContain('data-music-next="empty"');
    expect(html).toContain(translateMessage("music.next.empty"));
  });

  it("stays out of the sidebar radio, which has no room for it", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          current={track("now")}
          music={{
            channelId: CHANNEL,
            state: state({ queue: [track("q1")] }),
            receivedAt: Date.now(),
            open: false,
            listening: true,
          }}
          voiceState={voiceState()}
          canManage
          playing
          needsTap={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          listening
          {...knobs}
        />
      </TooltipProvider>,
    );
    expect(html).not.toContain("data-music-next");
  });

  it("counts the listeners once there is more than one", () => {
    const alone = bar({ queue: [] }, { occupancy: { [CHANNEL]: [] } });
    expect(alone).not.toContain("data-music-listeners");

    const html = bar(
      { queue: [] },
      {
        occupancy: {
          [CHANNEL]: [
            seat("peer-ana", { displayName: "Ana" }),
            seat("peer-bia", { displayName: "Bia", listeningMusic: false }),
          ],
        },
      },
    );
    expect(html).toContain("data-music-listeners");
    expect(html).toContain(translateMessage("music.listening", { count: 2 }));
  });
});

/**
 * A member gets the same bar, not a different one: the controls they may not
 * use are dimmed in place, so nothing under the pointer moves with rights.
 */
describe("the composer bar a member sees", () => {
  const knobs = {
    volume: 40,
    muted: false,
    ducking: true,
    listening: true,
    onOpenFila: () => {},
    onMute: () => {},
    onVolume: () => {},
    onToggleDucking: () => {},
  };
  const bar = (canManage: boolean, music: Partial<MusicState> = {}) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          tone="composer"
          current={track("now")}
          music={{
            channelId: CHANNEL,
            state: state(music),
            receivedAt: Date.now(),
            open: false,
            listening: true,
          }}
          voiceState={voiceState({ canManageMusic: canManage })}
          canManage={canManage}
          playing
          needsTap={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          {...knobs}
        />
      </TooltipProvider>,
    );

  it("keeps shuffle and repeat in place, disabled", () => {
    const html = bar(false);
    expect(html).toContain("data-music-shuffle");
    expect(html).toContain("data-music-repeat");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4);
  });

  /* Live, not dimmed: since the stops were gathered into one menu it holds
     Parar de ouvir, which is a member's to use. */
  it("keeps the overflow in place and usable", () => {
    const html = bar(false);
    expect(html).toContain("data-music-overflow");
    expect(html).not.toMatch(/data-music-overflow=""[^>]*disabled=""/);
  });

  it("puts vote-skip in the skip slot, with the count on the button", () => {
    const html = bar(false, { skipVotes: ["22222222-2222-4222-8222-222222222222"] });
    expect(html).toContain("data-music-vote-skip");
    expect(html).toContain(translateMessage("music.voteSkip.badge", { count: 1, needed: 2 }));
  });

  it("leaves a manager's bar working", () => {
    const html = bar(true);
    expect(html).toContain("data-music-shuffle");
    expect(html).toContain("data-music-repeat");
    expect(html).toContain("data-music-overflow");
    expect(html).not.toContain("data-music-vote-skip");
  });
});

/**
 * Stopping is personal: the room plays on without you. The bar has to say
 * that, because a player that just goes quiet reads as broken.
 */
/**
 * Three full-width rows above a composer is most of the bottom of a wide
 * window. The elements do not change; where they sit does.
 */
describe("the composer bar folds to one row when it has the width", () => {
  const html = () =>
    renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          tone="composer"
          current={track("now")}
          music={{
            channelId: CHANNEL,
            state: state({ queue: [track("q1", { title: "Daft Punk" })] }),
            receivedAt: Date.now(),
            open: false,
            listening: true,
          }}
          voiceState={voiceState()}
          canManage
          playing
          needsTap={false}
          listening
          volume={40}
          muted={false}
          ducking
          onOpenFila={() => {}}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          onMute={() => {}}
          onVolume={() => {}}
          onToggleDucking={() => {}}
        />
      </TooltipProvider>,
    );

  it("gives the middle column a bounded width, not the whole bar", () => {
    expect(html()).toContain("@min-[48rem]:grid-cols-[minmax(0,1fr)_minmax(18rem,34rem)_minmax(0,1fr)]");
  });

  /* At 1920 a 26rem cap left a 359px seek against Spotify's ~640. */
  it("lets the seek breathe on a wide window", () => {
    expect(html()).not.toContain("minmax(18rem,26rem)");
  });

  it("keeps the queue count as text, not as a badge", () => {
    const markup = html();
    expect(markup).toContain("data-music-next-count");
    expect(markup).not.toMatch(/data-music-next-count=""[^>]*bg-accent-soft/);
  });

  /* Under 28rem the transport alone is wider than the bar, so a shared row
     starved the title to nothing: art, controls, and no idea what is on. */
  it("gives the title the whole first line when the bar is narrowest", () => {
    expect(html()).toMatch(/col-span-full[^"]*@min-\[28rem\]:col-auto/);
  });

  it("moves the seek under the transport instead of across everything", () => {
    expect(html()).toMatch(
      /col-span-full[^"]*@min-\[48rem\]:col-start-2[^"]*@min-\[48rem\]:row-start-2/,
    );
  });

  it("moves the queue line under the title, into the space that was empty", () => {
    expect(html()).toMatch(
      /col-span-full[^"]*@min-\[48rem\]:col-start-1[^"]*@min-\[48rem\]:row-start-2/,
    );
  });

  it("drops the queue line's rule, which only divided stacked rows", () => {
    expect(html()).toContain("@min-[48rem]:border-t-0");
  });

  it("keeps the stacked rows below the breakpoint", () => {
    const markup = html();
    expect(markup).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(markup).toContain("@min-[28rem]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]");
  });
});

describe("the composer bar after Parar de ouvir", () => {
  const knobs = {
    volume: 40,
    muted: false,
    ducking: true,
    onOpenFila: () => {},
    onMute: () => {},
    onVolume: () => {},
    onToggleDucking: () => {},
  };
  const bar = (listening: boolean) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <MusicNowPlaying
          tone="composer"
          current={track("now")}
          music={{
            channelId: CHANNEL,
            state: state({ queue: [track("q1", { title: "Daft Punk" })] }),
            receivedAt: Date.now(),
            open: false,
            listening,
          }}
          voiceState={voiceState({
            occupancy: {
              [CHANNEL]: [seat("peer-ana"), seat("peer-bia")],
            },
          })}
          canManage
          playing
          needsTap={false}
          onPlayPause={() => {}}
          onSkip={() => {}}
          onTapToPlay={() => {}}
          listening={listening}
          {...knobs}
        />
      </TooltipProvider>,
    );

  it("says the room is still playing, and who for", () => {
    const html = bar(false);
    expect(html).toContain('data-music-listening="off"');
    expect(html).toContain(translateMessage("music.stopped.playing", { count: 2 }));
    expect(html).toContain(translateMessage("music.listen"));
  });

  it("drops the seek, because a position you cannot hear is noise", () => {
    expect(bar(false)).not.toContain('data-slider="scrub"');
    expect(bar(true)).toContain('data-slider="scrub"');
  });

  it("keeps the queue line, so the room stays legible", () => {
    expect(bar(false)).toContain("data-music-next");
    expect(bar(false)).toContain("Daft Punk");
  });

  it("is the ordinary bar again while listening", () => {
    const html = bar(true);
    expect(html).not.toContain('data-music-listening="off"');
    expect(html).not.toContain(translateMessage("music.stopped.playing", { count: 2 }));
  });
});

describe("musicListenerCount", () => {
  const room = (...flags: Array<boolean | undefined>): VoiceState =>
    voiceState({
      occupancy: {
        [CHANNEL]: flags.map((listeningMusic, index) =>
          seat(`peer-${index}`, listeningMusic === undefined ? {} : { listeningMusic }),
        ),
      },
    });

  it("reads an absent flag as listening, because an older client never sends it", () => {
    expect(musicListenerCount(room(undefined, undefined), true)).toBe(3);
  });

  it("drops the seats that stopped, and this machine when it stopped", () => {
    expect(musicListenerCount(room(false, true), true)).toBe(2);
    expect(musicListenerCount(room(true, true), false)).toBe(2);
  });
});

describe("MusicComposer", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
    resetMusicLocalPlaybackForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      send: () => {},
    });
  });

  it("renders no music chrome when idle and the Fila is closed", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicComposer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toBe("");
  });

  it("lets the sheet replace Tocar música while the queue is empty", () => {
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicComposer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-fila=\"sheet\"");
    expect(html).toContain("data-music-search");
    expect(html).not.toContain("data-music-composer-start");
  });

  it("puts the transport in the composer", () => {
    receiveMusic(
      CHANNEL,
      state({ current: track("now", { title: "Arctic Monkeys - Cornerstone" }) }),
    );
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicComposer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-composer");
    expect(html).toContain('data-music-now-playing="composer"');
    expect(html).toContain("Arctic Monkeys - Cornerstone");
    expect(html).toContain("h-14 w-14");
    expect(html).toContain("rounded-full");
    expect(html).toContain("data-slider=\"scrub\"");
    expect(html).toContain("col-span-full");
    expect(html).toMatch(/Previous|Voltar|music\.previous/);
    expect(html).toContain("data-music-shuffle");
    expect(html).toContain("data-music-repeat");
    expect(html).toContain("data-music-overflow");
    expect(html).not.toContain("data-music-queue-toggle");
    expect(html).not.toContain("data-music-composer-start");
    expect(html).not.toContain("data-slider=\"edge\"");
    expect(html).not.toContain("data-music-fila");
    expect(html).not.toContain("w-60");
  });

  it("expands Fila as a sheet, not a members rail", () => {
    receiveMusic(CHANNEL, state({ current: track("now") }));
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicComposer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-fila=\"sheet\"");
    expect(html).not.toContain("data-music-fila=\"drawer\"");
    expect(html).not.toContain("w-60");
    expect(html).toContain("max-h-[min(28rem,50dvh)]");
    expect(html).not.toContain("data-music-composer-start");
    expect(html).not.toContain("data-music-fila-play");
    expect(html).toContain("data-music-shuffle");
    expect(html).toContain("data-music-repeat");
    expect(html).toContain("data-music-overflow");
  });
});

describe("MusicFila", () => {
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

  it("is the queue only: no now-playing card or seek on the sheet", () => {
    receiveMusic(CHANNEL, state({ current: track("now", { durationMs: null }) }));
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicFila voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-fila");
    expect(html).toContain("data-music-fila=\"sheet\"");
    expect(html).not.toContain("w-60");
    expect(html).toContain("data-music-fila-close");
    expect(html).not.toContain("data-music-overflow");
    expect(html).toContain("data-music-stage-watch");
    expect(html).not.toContain("data-music-fila-play");
    expect(html).not.toContain("h-12 w-12");
    expect(html).not.toContain("data-music-vote-skip");
    expect(html).not.toContain("data-slider=\"scrub\"");
    expect(html).not.toContain("data-slider=\"volume\"");
    expect(html).not.toContain("data-music-stop-listening");
  });

  it("keeps play-on-art and seek on the drawer radio", () => {
    receiveMusic(CHANNEL, state({ current: track("now", { durationMs: 180_000 }) }));
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicFila variant="drawer" voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-fila=\"drawer\"");
    expect(html).toContain("data-music-overflow");
    expect(html).toContain("data-music-fila-play");
    expect(html).toContain("h-12 w-12");
    expect(html).toContain("data-slider=\"scrub\"");
    expect(html).not.toContain("data-indeterminate");
    expect(html).toMatch(/0:00[\s\S]*data-slider="scrub"[\s\S]*3:00/);
  });

  it("keeps the field mounted with a track on, and drops the header's plus", () => {
    receiveMusic(CHANNEL, state());
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicFila voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-search");
    expect(html).not.toContain("data-music-add");
    expect(html).not.toContain("data-music-repeat");
  });

  it("opens search when nothing is playing", () => {
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicFila voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-search");
    expect(html).toContain("data-music-fila-close");
  });

  it("keeps skip off Fila when the viewer cannot manage", () => {
    receiveMusic(CHANNEL, state());
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicFila voiceState={voiceState({ canManageMusic: false })} />
      </TooltipProvider>,
    );
    expect(html).not.toContain("data-music-vote-skip");
    expect(html).not.toContain("data-music-overflow");
    expect(html).toContain("data-music-stage-watch");
    expect(html).not.toContain("data-music-fila-play");
  });

  it("re-adds from Tocadas with an icon, not a labeled button", () => {
    receiveMusic(
      CHANNEL,
      state({ history: [track("old", { title: "Tempo perdido" })] }),
    );
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicFila voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-history");
    expect(html).toContain("data-music-play-again");
    expect(html).not.toMatch(/>Play again</);
    expect(html).not.toMatch(/>Tocar de novo</);
  });
});

describe("ChannelMusicCard", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
    resetChannelMusicCardRightsForTests();
  });

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
    expect(html).not.toContain("data-music-card-play");
    expect(html).not.toContain("data-music-card-skip");
    expect(html).not.toContain("data-music-vote-skip");
  });

  it("hides play and skip in the call", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ChannelMusicCard
          channelId={CHANNEL}
          track={{ videoId: "aaaaaaaaaaa", title: "Legião", thumbnailUrl: null, listeners: 1 }}
          inCall
          canManageMusic={false}
          userId="33333333-3333-4333-8333-333333333333"
          roomSize={2}
        />
      </TooltipProvider>,
    );
    expect(html).not.toContain("data-music-vote-skip");
    expect(html).not.toContain("data-music-card-play");
    expect(html).not.toContain("data-music-card-skip");
  });

  it("stays listen-only for a manager already in the call", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ChannelMusicCard
          channelId={CHANNEL}
          track={{ videoId: "aaaaaaaaaaa", title: "Legião", thumbnailUrl: null, listeners: 1 }}
          inCall
          canManageMusic
          userId="33333333-3333-4333-8333-333333333333"
          roomSize={2}
        />
      </TooltipProvider>,
    );
    expect(html).not.toContain("data-music-card-play");
    expect(html).not.toContain("data-music-card-skip");
    expect(html).not.toContain("data-music-vote-skip");
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
    resetChannelMusicCardRightsForTests();
    resetMusicLocalPlaybackForTests();
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

  it("stays the idle row when Fila is open and nothing is on", () => {
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain('data-music-mini-player="idle"');
    expect(html).toContain("data-music-fila=\"drawer\"");
    expect(html).toContain("data-music-search");
    expect(html).toContain("data-music-embed-dock");
  });

  it("keeps the icons-only sidebar as a start button, not a search box", () => {
    setMusicOpen(true);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} compact />
      </TooltipProvider>,
    );
    expect(html).toContain('data-music-mini-player="idle"');
    expect(html).toContain("h-8 w-8");
    expect(html).toContain("data-music-fila=\"drawer\"");
    expect(html).toContain("data-music-embed-dock");
  });

  it("keeps Ouvir on the compact bar when the viewer is not listening", () => {
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
    expect(html).toContain("data-music-now-playing");
    expect(html).toContain("Legião Urbana");
    expect(html).not.toContain("data-music-speaker");
  });

  it("shows the compact bar when a room is already playing", () => {
    receiveMusic(CHANNEL, state({ current: track("now", { title: "Legião Urbana" }) }));
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-now-playing");
    expect(html).toContain("data-music-speaker");
    expect(html).not.toContain("data-music-fila=\"\"");
    expect(html).not.toContain("data-music-fila-close");
    expect(html).not.toContain("data-music-search");
    expect(html).not.toContain("aspect-video");
  });

  it("does not open Fila when this machine adds a song", () => {
    addTrack({
      provider: "youtube",
      videoId: "aaaaaaaaaaa",
      title: "Legião Urbana",
      sourceUrl: null,
      thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
      durationMs: 1,
    });
    expect(getMusicSnapshot().open).toBe(false);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-now-playing");
    expect(html).not.toContain("data-music-fila-close");
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

  it("hides sidebar chrome when the composer owns the bar", () => {
    receiveMusic(CHANNEL, state({ current: track("now", { title: "Legião Urbana" }) }));
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MusicMiniPlayer voiceState={voiceState()} chrome={false} />
      </TooltipProvider>,
    );
    expect(html).toContain("data-music-embed-dock");
    expect(html).toContain('data-music-mini-player="dock"');
    expect(html).not.toContain("data-music-now-playing");
    expect(html).not.toContain("data-music-composer-start");
    expect(html).not.toContain("Tocar música");
  });
});
