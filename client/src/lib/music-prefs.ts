import { useEffect, useSyncExternalStore } from "react";
import { isRedesignOn } from "@/lib/redesign";
import {
  getMusicSnapshot,
  musicOpenedHereTrackId,
  setListening,
  subscribeMusic,
} from "@/lib/music-store";

/**
 * Personal music choices for this browser: whether the clip is on the
 * stage, whether speech ducks the track, and whether a room starting
 * music puts the player on automatically. Video never lives in the
 * sidebar; stage is the only picture.
 */

export type MusicPlacement = "hidden" | "stage";

export interface MusicPrefs {
  placement: MusicPlacement;
  ducking: boolean;
  autoJoin: boolean;
}

export type MusicPictureMode = "hidden" | "stage";

const PLACEMENT_KEY = "pqp:music-placement";
const DUCKING_KEY = "pqp:music-duck";
/*
 * A new key, because the Rádio is opt-in now: you hear it after Entrar na
 * Rádio, not because you sat down in the call. `setPrefs` writes all three
 * keys on any change, so the old key holds "1" for everybody who ever
 * touched the placement or the ducking, and a new default under it would
 * reach almost nobody.
 */
const AUTO_JOIN_KEY = "pqp:music-auto-join-v2";
// The old look keeps its own key and its default of on.
const AUTO_JOIN_KEY_OLD = "pqp:music-auto-join";

const DEFAULTS: MusicPrefs = {
  placement: "hidden",
  ducking: true,
  autoJoin: false,
};

const listeners = new Set<() => void>();

let snapshot: MusicPrefs = { ...DEFAULTS };
let loaded = false;
let loadedRedesign = false;

function autoJoinKey(redesign: boolean): string {
  return redesign ? AUTO_JOIN_KEY : AUTO_JOIN_KEY_OLD;
}

function readAutoJoin(redesign: boolean): boolean {
  return parseFlag(readStored(autoJoinKey(redesign)), redesign ? DEFAULTS.autoJoin : true);
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}

function parsePlacement(raw: string | null): MusicPlacement {
  return raw === "stage" ? "stage" : "hidden";
}

function parseFlag(raw: string | null, fallback: boolean): boolean {
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  return fallback;
}

function load(): MusicPrefs {
  const redesign = isRedesignOn();
  if (loaded) {
    // The look can change under a running page: re-read only the one pref
    // whose key and default depend on it.
    if (redesign !== loadedRedesign) {
      loadedRedesign = redesign;
      snapshot = { ...snapshot, autoJoin: readAutoJoin(redesign) };
    }
    return snapshot;
  }
  loaded = true;
  loadedRedesign = redesign;
  snapshot = {
    placement: parsePlacement(readStored(PLACEMENT_KEY)),
    ducking: parseFlag(readStored(DUCKING_KEY), DEFAULTS.ducking),
    autoJoin: readAutoJoin(redesign),
  };
  return snapshot;
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setPrefs(partial: Partial<MusicPrefs>): void {
  const current = load();
  const next: MusicPrefs = { ...current, ...partial };
  if (
    next.placement === current.placement &&
    next.ducking === current.ducking &&
    next.autoJoin === current.autoJoin
  ) {
    return;
  }
  snapshot = next;
  writeStored(PLACEMENT_KEY, next.placement);
  writeStored(DUCKING_KEY, next.ducking ? "1" : "0");
  writeStored(autoJoinKey(isRedesignOn()), next.autoJoin ? "1" : "0");
  emit();
}

export function getMusicPrefs(): MusicPrefs {
  return load();
}

export function subscribeMusicPrefs(listener: () => void): () => void {
  load();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMusicPrefs(): MusicPrefs {
  return useSyncExternalStore(subscribeMusicPrefs, getMusicPrefs, getMusicPrefs);
}

export function setMusicPlacement(placement: MusicPlacement): void {
  setPrefs({ placement });
}

/** Hide or stage: never two pictures, never a sidebar 16:9. */
export function musicPictureMode(
  prefs: Pick<MusicPrefs, "placement">,
): MusicPictureMode {
  return prefs.placement === "stage" ? "stage" : "hidden";
}

export function setMusicDucking(ducking: boolean): void {
  setPrefs({ ducking });
}

export function setMusicAutoJoin(autoJoin: boolean): void {
  setPrefs({ autoJoin });
}

export function useMusicPlacement(): MusicPlacement {
  return useMusicPrefs().placement;
}

export function useMusicDucking(): boolean {
  return useMusicPrefs().ducking;
}

export function useMusicAutoJoin(): boolean {
  return useMusicPrefs().autoJoin;
}

/**
 * Off + a track appearing (or already on when you sit down) means the
 * Rádio invite, not the player. A skip from one track to another is not
 * that transition, and neither is a queue that ran dry and got a new song
 * after you had joined: being in the Rádio survives an empty queue.
 */
export function shouldAutoDeclineListen(input: {
  autoJoin: boolean;
  previousTrackId: string | null;
  nextTrackId: string | null;
  seatChanged: boolean;
  /** This seat chose Entrar na Rádio since it sat down. */
  joined?: boolean;
  /** This machine just started the track in an empty room: whoever opens the Rádio is in. */
  openedHere?: boolean;
}): boolean {
  if (input.autoJoin || input.nextTrackId === null) {
    return false;
  }
  if (input.joined || input.openedHere) {
    return false;
  }
  if (input.seatChanged) {
    return true;
  }
  return input.previousTrackId === null;
}

/*
 * Which call this tab joined the Rádio in. Per tab (sessionStorage), so a
 * reload in the middle of a song, including the automatic one after a
 * deploy, keeps you in the Rádio instead of handing you the invite again.
 */
const JOINED_KEY = "pqp:music-joined";
const JOIN_INTENT_KEY = "pqp:music-join-intent";
const JOIN_INTENT_TTL_MS = 30_000;

function readJoined(channelId: string | null): boolean {
  if (!channelId) {
    return false;
  }
  try {
    return sessionStorage.getItem(JOINED_KEY) === channelId;
  } catch {
    return false;
  }
}

function writeJoined(channelId: string | null, joined: boolean): void {
  try {
    if (joined && channelId) {
      sessionStorage.setItem(JOINED_KEY, channelId);
    } else if (sessionStorage.getItem(JOINED_KEY) === channelId) {
      sessionStorage.removeItem(JOINED_KEY);
    }
  } catch {
    // per-tab convenience only
  }
}

/**
 * The person asked for the Rádio before they had a seat (Entrar on the
 * sidebar's music card, outside the call). Recorded as already joined, so
 * the seat change that follows honours it instead of showing the invite.
 */
export function markRadioJoinIntent(channelId: string, now: number = Date.now()): void {
  try {
    sessionStorage.setItem(JOIN_INTENT_KEY, `${channelId}|${now}`);
  } catch {
    // per-tab convenience only
  }
}

/**
 * The intent is read once, by the seat change it was meant for. A join that
 * failed or was cancelled leaves it behind, so it counts only for a short
 * while: a seat taken much later is a new decision, not this one.
 */
function consumeJoinIntent(channelId: string | null, now: number = Date.now()): boolean {
  if (!channelId) {
    return false;
  }
  try {
    const raw = sessionStorage.getItem(JOIN_INTENT_KEY);
    if (raw === null) {
      return false;
    }
    const [id, stamp] = raw.split("|");
    if (id !== channelId) {
      return false;
    }
    sessionStorage.removeItem(JOIN_INTENT_KEY);
    const age = now - Number(stamp);
    return Number.isFinite(age) && age >= 0 && age <= JOIN_INTENT_TTL_MS;
  } catch {
    return false;
  }
}

let joinGate = {
  channelId: null as string | null,
  trackId: null as string | null,
  joined: false,
  listening: true,
  /**
   * The opened track already counted once: a reconnect replaying the same id is
   * not a new open. Ids are minted per add (`mintTrack`), so the same song
   * started again is a new id and a new open. Not reset when the track goes null,
   * or every API restart would put a person who pressed Sair back in the Rádio.
   */
  openedTrackId: null as string | null,
};

export function applyMusicJoinGate(
  channelId: string | null,
  trackId: string | null,
  autoJoin: boolean,
  seat: { listening?: boolean; openedHere?: boolean } = {},
): boolean {
  const seatChanged = joinGate.channelId !== channelId;
  if (seatChanged) {
    // Leaving a call in this page (not a reload, which never gets here)
    // ends being in its Rádio too.
    if (joinGate.channelId !== null) {
      writeJoined(joinGate.channelId, false);
    }
    const intended = consumeJoinIntent(channelId);
    if (intended) {
      writeJoined(channelId, true);
    }
    joinGate = {
      channelId,
      trackId: null,
      joined: intended || readJoined(channelId),
      listening: true,
      openedTrackId: null,
    };
  }
  const listening = seat.listening ?? joinGate.listening;
  // Off to on in the same seat is the person pressing Entrar na Rádio, and
  // on to off with a track on is Sair da Rádio.
  if (!seatChanged && joinGate.listening !== listening) {
    if (listening) {
      joinGate.joined = true;
    } else if (trackId !== null && trackId === joinGate.trackId) {
      joinGate.joined = false;
    }
    writeJoined(channelId, joinGate.joined);
  }
  const previousTrackId = joinGate.trackId;
  // Being in the Rádio is the new look's idea. The old look keeps its rule:
  // with auto-join off, every track that appears asks again.
  const radio = isRedesignOn();
  const opened =
    radio && Boolean(seat.openedHere) && trackId !== null && joinGate.openedTrackId !== trackId;
  const declined = shouldAutoDeclineListen({
    autoJoin,
    previousTrackId,
    nextTrackId: trackId,
    seatChanged,
    joined: radio && joinGate.joined,
    openedHere: opened,
  });
  if (opened) {
    joinGate.openedTrackId = trackId;
    joinGate.joined = true;
    writeJoined(channelId, true);
  }
  joinGate.trackId = trackId;
  // Whoever adds the track here is in its Rádio, even from a tab that was
  // not listening: turn listening on, or they would see the invite for
  // their own song and hear nothing.
  const turnOn = opened && !listening;
  joinGate.listening = declined ? false : turnOn ? true : listening;
  if (declined) {
    setListening(false);
  } else if (turnOn) {
    setListening(true);
  }
  return declined;
}

/**
 * The person hung up. Being in the Rádio ends with the seat, but a hang-up
 * leaves the music session where it was, so a rejoin of the same call in the
 * same page looked like the same seat and the music played with no invite.
 * Not for a seat that is only retaken (the microphone coming on): that is
 * the same person in the same Rádio.
 */
export function endRadioSeat(): void {
  if (!isRedesignOn() || joinGate.channelId === null) {
    return;
  }
  writeJoined(joinGate.channelId, false);
  joinGate = { channelId: null, trackId: null, joined: false, listening: true, openedTrackId: null };
}

function onMusicSessionChange() {
  const snap = getMusicSnapshot();
  const current = snap.state?.current ?? null;
  applyMusicJoinGate(snap.channelId, current?.id ?? null, getMusicPrefs().autoJoin, {
    listening: snap.listening,
    openedHere: current !== null && current.id === musicOpenedHereTrackId(),
  });
}

let joinGateSubscribed = false;

function ensureJoinGate() {
  if (joinGateSubscribed) {
    return;
  }
  joinGateSubscribed = true;
  subscribeMusic(onMusicSessionChange);
}

/** Call once from the sidebar player so the gate is live for this tab. */
export function useMusicJoinGate(): void {
  useEffect(() => {
    ensureJoinGate();
    onMusicSessionChange();
  }, []);
}

export interface MusicStagePresence {
  active: boolean;
  title: string;
  addedByName: string;
  addedByUserId: string;
}

export function musicStagePictureActive(input: {
  hasCurrent: boolean;
  listening: boolean;
  onStage: boolean;
}): boolean {
  return input.hasCurrent && input.listening && input.onStage;
}

let presenceCache: MusicStagePresence = {
  active: false,
  title: "",
  addedByName: "",
  addedByUserId: "",
};

function getMusicStagePresence(): MusicStagePresence {
  const snap = getMusicSnapshot();
  const current = snap.state?.current ?? null;
  const next: MusicStagePresence = {
    active: musicStagePictureActive({
      hasCurrent: Boolean(current),
      listening: snap.listening,
      onStage: load().placement === "stage",
    }),
    title: current?.title ?? "",
    addedByName: current?.addedByName ?? "",
    addedByUserId: current?.addedByUserId ?? "",
  };
  if (
    presenceCache.active === next.active &&
    presenceCache.title === next.title &&
    presenceCache.addedByName === next.addedByName &&
    presenceCache.addedByUserId === next.addedByUserId
  ) {
    return presenceCache;
  }
  presenceCache = next;
  return presenceCache;
}

function subscribeMusicStagePresence(listener: () => void): () => void {
  const unsubMusic = subscribeMusic(listener);
  const unsubPrefs = subscribeMusicPrefs(listener);
  return () => {
    unsubMusic();
    unsubPrefs();
  };
}

/**
 * Track / listening / local picture. A position sample must not re-render
 * the stage. Leaving the stage is the only way this turns off.
 */
export function useMusicStagePresence(): MusicStagePresence {
  return useSyncExternalStore(
    subscribeMusicStagePresence,
    getMusicStagePresence,
    getMusicStagePresence,
  );
}

/** A page reload, for tests: the gate's memory goes, the tab's storage stays. */
export function resetJoinGateForReload(): void {
  joinGate = { channelId: null, trackId: null, joined: false, listening: true, openedTrackId: null };
}

export function resetMusicPrefsForTests(): void {
  snapshot = { ...DEFAULTS };
  loaded = false;
  listeners.clear();
  joinGate = { channelId: null, trackId: null, joined: false, listening: true, openedTrackId: null };
  try {
    sessionStorage.removeItem(JOINED_KEY);
  } catch {
    // no storage in this environment
  }
  presenceCache = {
    active: false,
    title: "",
    addedByName: "",
    addedByUserId: "",
  };
}
