import type { MusicState, MusicTrack } from "@pqp/shared";
import { useEffect } from "react";
import type { VoiceState } from "@/hooks/use-voice";
import { MusicComposer } from "@/components/voice/music-composer";
import {
  receiveMusic,
  setMusicOpen,
  setMusicSession,
  useMusic,
} from "@/lib/music-store";

const CHANNEL = "qa-music-channel";
const ME = "qa-music-me";

const cover = (seed: string) => `https://api.dicebear.com/9.x/shapes/png?seed=${seed}`;

const track = (id: string, title: string, by: string, minutes: number): MusicTrack => ({
  id,
  provider: "youtube",
  videoId: id.padEnd(11, "a").slice(0, 11),
  title,
  sourceUrl: null,
  thumbnailUrl: cover(id),
  durationMs: minutes * 60_000,
  addedByUserId: `qa-${by.toLowerCase()}`,
  addedByName: by,
});

const STATE: MusicState = {
  current: track("now", "Racionais MC's - Negro Drama", "Bia", 6.8),
  queue: [
    track("q1", "Tim Maia - Ela Partiu", "Caio", 4.2),
    track("q2", "Gal Costa - Vapor Barato", "Bia", 5.1),
    track("q3", "Marina Sena - Por Supuesto", "Rafa", 3.4),
  ],
  status: "playing",
  positionMs: 95_000,
  atMs: 1,
  rev: 1,
  actorId: "peer-bia",
  openControls: false,
  repeat: "off",
  skipVotes: [],
  history: [track("h1", "Jorge Ben Jor - Taj Mahal", "Caio", 3.3)],
};

const VOICE = {
  status: "connected",
  peerId: "peer-me",
  canSpeak: true,
  canStream: true,
  canManageMusic: true,
  voiceChannelId: CHANNEL,
  self: { peerId: "peer-me", userId: ME, displayName: "Lia", avatarUrl: null },
  occupancy: { [CHANNEL]: [] },
  speakingPeerIds: [],
  isDeafened: false,
  isTransmitting: false,
  channelMusic: {},
} as unknown as VoiceState;

/**
 * The music queue open in a call's composer, with three songs waiting and one
 * in the history. The store is global, so this block owns a fake session for
 * as long as it is mounted, and opens the queue again if a key on the page
 * (Escape, from another block) closes it.
 */
export function MusicQueueSpecimen() {
  const music = useMusic();
  useEffect(() => {
    setMusicSession({ channelId: CHANNEL, peerId: "peer-me", userId: ME, displayName: "Lia", send: () => {} });
    receiveMusic(CHANNEL, STATE);
    return () => setMusicSession(null);
  }, []);
  useEffect(() => {
    if (music.state && !music.open) {
      setMusicOpen(true);
    }
  }, [music.state, music.open]);
  return (
    <div data-testid="qa-music-queue" className="w-[480px] p-4">
      {/* The composer's well, which the queue and its player sit at the top of. */}
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-2">
        <MusicComposer voiceState={VOICE} />
        <div className="px-3 py-3 text-sm text-text-tertiary">Conversar em #sala-de-som</div>
      </div>
    </div>
  );
}
