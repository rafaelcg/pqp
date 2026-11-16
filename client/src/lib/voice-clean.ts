import { isHintSeen, rememberHint } from "./hints";

/**
 * "Voz limpa": the product name for advanced, RNNoise-based noise
 * suppression (`client/src/lib/noise-suppression.ts`, `NoiseSuppressionMode
 * === "advanced"`). RNNoise itself is never named in the UI outside the
 * Settings description — see `docs/NOISE_SUPPRESSION.md`.
 *
 * This module holds what has to be a pure function to be tested without a DOM:
 * whether the NOVO dot in Settings is still owed. (The one-time corner card
 * that offered to turn it on was removed on 2026-11-01.)
 */

// ------------------------------------------------------- settings NOVO dot

/**
 * Per browser, not per account: the dot is furniture pointing at a row, not
 * a campaign, so it does not need `lib/hints.ts`'s automation/localhost
 * escape hatches beyond the shared "seen" store those helpers already are.
 */
export const VOICE_CLEAN_SETTINGS_SEEN_KEY = "pqp:voice-clean-settings-seen";

export function isVoiceCleanSettingsSeen(
  storage?: Pick<Storage, "getItem"> | null,
  persist?: boolean,
): boolean {
  return isHintSeen(VOICE_CLEAN_SETTINGS_SEEN_KEY, storage, persist);
}

export function markVoiceCleanSettingsSeen(
  storage?: Pick<Storage, "setItem"> | null,
  persist?: boolean,
): void {
  rememberHint(VOICE_CLEAN_SETTINGS_SEEN_KEY, storage, persist);
}

/**
 * The dot on the noise-suppression row clears the first time either happens:
 * the Voice section of Settings is opened (`markVoiceCleanSettingsSeen`), or
 * the account already answered the old nudge card
 * (`preferences.voiceCleanNudgeDismissedAt`, no longer written by the client).
 */
export function shouldShowVoiceCleanSettingsBadge(input: {
  settingsSeen: boolean;
  nudgeDismissed: boolean;
}): boolean {
  return !input.settingsSeen && !input.nudgeDismissed;
}
