import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { MusicResolved, MusicState, MusicTrack } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { VoiceState } from "@/hooks/use-voice";
import {
  addTrack,
  getMusicSnapshot,
  resetMusicStoreForTests,
  setMusicSession,
} from "@/lib/music-store";
import { ChannelMusicCard } from "@/components/voice/channel-music-card";
import { MusicBarButton } from "@/components/voice/music-bar-button";
import { musicActivityFromDiff } from "@/components/voice/music-panel";
import { MusicNowPlaying } from "@/components/voice/music-now-playing";
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
