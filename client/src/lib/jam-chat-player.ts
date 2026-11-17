import { useEffect, useSyncExternalStore } from "react";
import type { JamEngine } from "@/lib/jam";
import { fetchJamSong } from "@/lib/jam-api";
import { isJamStudioOpen, isJamWallOpen } from "@/lib/jam-hint-context";
import { isJamPlaying, useJamPlaying } from "@/lib/jam-now-playing";
import { getJamEngine, peekJamEngine, releaseJamEngine, syncJamStems, unlockJamAudio } from "@/lib/jam-session";

/**
 * Playing a Jam song from a card in the conversation.
 *
 * THE ONE PLAYER. This does not make a second one: it plays through the same
 * engine the Jam's wall, its song panel and its studio share (`jam-session.ts`),
 * so the sidebar row and the wall already know a song is playing (they follow
 * the engine's transport, `jam-now-playing.ts`) and opening the song from the
 * card hands it over (from the top). Starting a song here takes the stems of whatever
 * the engine held before out of it, so two songs never sound at once.
 *
 * What a card needs to know is small: is MY song the one the engine holds, is it
 * playing, is it loading, did it fail. "Holds" is read from the engine itself (its
 * stems are the song's tracks), not remembered, so a song that the wall replaced
 * under the card is simply not this card's any more.
 *
 * The engine is closed when the last card of the song it holds goes away and the
 * Jam is not on screen (nobody keeps an AudioContext idling behind a chat); with
 * the wall open it belongs to the wall and goes on.
 */

interface Claim {
  songId: string;
  /** The in-mix tracks the engine was given for this song. */
  trackIds: readonly string[];
  engine: JamEngine;
}

let claim: Claim | null = null;
let loadingSong: string | null = null;
let failedSong: string | null = null;
let failTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const listeners = new Set<() => void>();
/** The card's own link was followed: the Jam's page is on its way and takes the engine over. */
let handoff: { songId: string; playing: boolean; until: number } | null = null;
const HANDOFF_MS = 10_000;

/**
 * Called when the person opens the song from its card. The chat is about to unmount (and the card
 * with it) before the Jam's page has mounted: the engine is kept for a moment so the Jam's page
 * owns it from there, and if the song was playing the page starts it again (`takeHandoffAutoplay`),
 * from the top: the page's first read of the song swaps the engine's stems, which stops it.
 */
export function holdJamEngineForHandoff(songId: string): void {
  handoff = { songId, playing: holds(songId) && isJamPlaying(), until: Date.now() + HANDOFF_MS };
}

/** The Jam's page opened this song from a card that was playing it: start it. Spent once. */
export function takeHandoffAutoplay(songId: string | null): boolean {
  const pending = handoff;
  if (!pending || !songId || pending.songId !== songId || Date.now() > pending.until) {
    return false;
  }
  handoff = null;
  return pending.playing;
}

/** Cards on screen, per song, so the engine can be let go when the last one leaves. */
const mounted = new Map<string, number>();

function bump() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function holds(songId: string): boolean {
  const engine = peekJamEngine();
  return (
    claim !== null &&
    claim.songId === songId &&
    claim.engine === engine &&
    engine !== null &&
    claim.trackIds.length > 0 &&
    claim.trackIds.every((id) => engine.player.stem(id) !== null)
  );
}

/** The start in progress (one at a time): a later click on another song, or the last card leaving, replaces it. */
let operation: { id: number; songId: string } | null = null;
let operationSeq = 0;

function stale(op: { id: number }): boolean {
  return operation === null || operation.id !== op.id;
}

/** A start failed. A start that was replaced meanwhile says nothing: it is somebody else's turn now. */
function fail(songId: string, op: { id: number }) {
  if (stale(op)) {
    return;
  }
  operation = null;
  if (loadingSong === songId) {
    loadingSong = null;
  }
  if (claim?.songId === songId) {
    claim = null;
  }
  failedSong = songId;
  if (failTimer) {
    clearTimeout(failTimer);
  }
  failTimer = setTimeout(() => {
    failedSong = null;
    failTimer = null;
    bump();
  }, 4000);
  bump();
}

/**
 * The round button of a card. Call it from the click itself: it unlocks the
 * audio in the very task of the gesture, which is what a browser wants before it
 * lets a page make sound.
 */
export function toggleJamCardSong(songId: string): void {
  unlockJamAudio();
  if (loadingSong === songId) {
    return;
  }
  const op = { id: ++operationSeq, songId };
  void run(songId, op).catch(() => {
    // A failure after the claim (resume or play refused) has already cleared the operation: say it anyway.
    if (operation === null && claim?.songId === songId) {
      operation = op;
    }
    fail(songId, op);
  });
}

async function run(songId: string, op: { id: number; songId: string }): Promise<void> {
  const engine = await getJamEngine();
  if (holds(songId)) {
    if (engine.player.state === "playing") {
      engine.player.pause();
    } else {
      await engine.context.resume();
      await engine.player.play();
    }
    bump();
    return;
  }
  // This start is the one in progress now; whatever was starting before is stale and gives up.
  operation = op;
  loadingSong = songId;
  failedSong = null;
  bump();
  // Fresh addresses for the media, every time a song is started: what the card was drawn from
  // may be older than the links in it are good for.
  const detail = await fetchJamSong(songId);
  if (stale(op)) {
    return;
  }
  const inMix = detail.tracks.filter((track) => track.inMix);
  if (inMix.length === 0) {
    fail(songId, op);
    return;
  }
  engine.player.stop();
  await syncJamStems(engine, detail.tracks);
  if (stale(op)) {
    return;
  }
  if (!inMix.every((track) => engine.player.stem(track.id) !== null)) {
    fail(songId, op);
    return;
  }
  claim = { songId, trackIds: inMix.map((track) => track.id), engine };
  loadingSong = null;
  operation = null;
  bump();
  await engine.context.resume();
  await engine.player.play(0);
  bump();
}

export type JamCardPlayState = "idle" | "loading" | "playing" | "paused" | "failed";

/** What a card of this song shows: and its own mount is what lets the engine go when the last one leaves. */
export function useJamCardPlayer(songId: string | null): { state: JamCardPlayState; engine: JamEngine | null } {
  const playing = useJamPlaying(true);
  useSyncExternalStore(subscribe, () => version, () => 0);
  useEffect(() => {
    if (!songId) {
      return;
    }
    mounted.set(songId, (mounted.get(songId) ?? 0) + 1);
    return () => {
      const left = (mounted.get(songId) ?? 1) - 1;
      if (left > 0) {
        mounted.set(songId, left);
        return;
      }
      mounted.delete(songId);
      // After the commit: a click on the Jam row unmounts the chat and mounts the wall in one
      // pass, and the wall says it is on screen only once it has mounted.
      setTimeout(() => {
        const loading = loadingSong === songId;
        if (mounted.has(songId) || (claim?.songId !== songId && !loading)) {
          return;
        }
        // The Jam is on screen now: the engine belongs to it and the song goes on (the wall
        // marks its tile, and opening the song hands it over).
        if (isJamWallOpen() || isJamStudioOpen() || (handoff !== null && Date.now() < handoff.until)) {
          return;
        }
        claim = null;
        if (loading) {
          // The start still in flight has nobody to play for: it gives up where it stands.
          loadingSong = null;
          operation = null;
        }
        void releaseJamEngine();
        bump();
      }, 0);
    };
  }, [songId]);
  if (!songId) {
    return { state: "idle", engine: null };
  }
  if (loadingSong === songId) {
    return { state: "loading", engine: null };
  }
  if (failedSong === songId) {
    return { state: "failed", engine: null };
  }
  if (holds(songId)) {
    return { state: playing && isJamPlaying() ? "playing" : "paused", engine: claim!.engine };
  }
  return { state: "idle", engine: null };
}

/**
 * The song a card in a conversation started and the engine is still playing, so the
 * Jam's wall can mark its tile the way it marks the one it has open.
 */
export function useJamChatSongPlaying(): string | null {
  const playing = useJamPlaying(true);
  useSyncExternalStore(subscribe, () => version, () => 0);
  return playing && claim !== null && holds(claim.songId) ? claim.songId : null;
}

/** Test seam. */
export function resetJamChatPlayerForTests(): void {
  claim = null;
  loadingSong = null;
  failedSong = null;
  operation = null;
  mounted.clear();
  bump();
}
