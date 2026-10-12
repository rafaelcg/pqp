import { useSyncExternalStore } from "react";
import { voiceTranscriptionPrefs, type UserPreferences } from "@pqp/shared";
import { queuePreferenceSync } from "@/lib/preferences";

/**
 * The two halves of voice note transcription, both on until turned off:
 *
 *   * `mine`: my notes may be transcribed. The server copies it onto each note
 *     when the note is minted, so turning it off never reaches back into notes
 *     already sent.
 *   * `show`: I read transcripts. Off hides every transcript from this
 *     account (and the server stops transcribing a conversation's notes for
 *     me alone).
 *
 * Local first, like `chat-display.ts`: the device keeps the last answer so the
 * first render is right, the account copy follows the person to the next
 * device, and the server wins on read. The preference is replaced as a whole on
 * write, so every write sends both halves.
 */

export interface VoiceTranscriptionPrefs {
  mine: boolean;
  show: boolean;
}

export const VOICE_TRANSCRIPTION_STORAGE_KEY = "pqp-voice-transcription";

export const DEFAULT_VOICE_TRANSCRIPTION: VoiceTranscriptionPrefs = {
  mine: true,
  show: true,
};

function readStored(): VoiceTranscriptionPrefs {
  try {
    const raw = localStorage.getItem(VOICE_TRANSCRIPTION_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_VOICE_TRANSCRIPTION;
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return DEFAULT_VOICE_TRANSCRIPTION;
    }
    return voiceTranscriptionPrefs({
      voiceTranscription: parsed as NonNullable<UserPreferences["voiceTranscription"]>,
    });
  } catch {
    return DEFAULT_VOICE_TRANSCRIPTION;
  }
}

function store(next: VoiceTranscriptionPrefs): void {
  try {
    localStorage.setItem(VOICE_TRANSCRIPTION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence is a convenience.
  }
}

let state: VoiceTranscriptionPrefs = readStored();
const listeners = new Set<() => void>();

export function getVoiceTranscription(): VoiceTranscriptionPrefs {
  return state;
}

export function subscribeVoiceTranscription(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: VoiceTranscriptionPrefs): boolean {
  if (next.mine === state.mine && next.show === state.show) {
    return false;
  }
  state = next;
  store(next);
  for (const listener of listeners) {
    listener();
  }
  return true;
}

/** A change the person made. Applied here at once, then sent as a whole. */
export function setVoiceTranscription(patch: Partial<VoiceTranscriptionPrefs>): void {
  const next = { ...state, ...patch };
  commit(next);
  queuePreferenceSync({ voiceTranscription: next }, { immediate: true });
}

/**
 * What the account says, from `/api/me`. Applied locally and never sent back,
 * the same rule every other adopted preference follows. An account that has
 * never chosen sends nothing, and this device's copy stands.
 */
export function adoptVoiceTranscription(
  preferences: Pick<UserPreferences, "voiceTranscription"> | null | undefined,
): void {
  if (!preferences?.voiceTranscription) {
    return;
  }
  commit(voiceTranscriptionPrefs(preferences));
}

export function resetVoiceTranscriptionForTests(): void {
  state = DEFAULT_VOICE_TRANSCRIPTION;
  try {
    localStorage.removeItem(VOICE_TRANSCRIPTION_STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const listener of listeners) {
    listener();
  }
}

export function useVoiceTranscription(): VoiceTranscriptionPrefs {
  return useSyncExternalStore(
    subscribeVoiceTranscription,
    getVoiceTranscription,
    () => DEFAULT_VOICE_TRANSCRIPTION,
  );
}

// -------------------------------------------------------------- availability

/**
 * Whether anything in this session has shown that transcription exists. The
 * flag is per server, so the settings tab cannot ask one question and trust
 * it: it asks the global one (what conversations read) and also believes any
 * card that arrived with a transcript block, or a composer that was told the
 * flag is on for its server. Without both, the switches would be missing for
 * a person whose only voice notes are in the one server that has it.
 */
let available = false;
const availabilityListeners = new Set<() => void>();

export function markTranscriptionAvailable(): void {
  if (available) {
    return;
  }
  available = true;
  for (const listener of availabilityListeners) {
    listener();
  }
}

export function useTranscriptionSeen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      availabilityListeners.add(listener);
      return () => {
        availabilityListeners.delete(listener);
      };
    },
    () => available,
    () => false,
  );
}

export function resetTranscriptionAvailableForTests(): void {
  available = false;
}
