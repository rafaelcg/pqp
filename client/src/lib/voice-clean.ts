import { isHintSeen, rememberHint } from "./hints";

/**
 * "Voz limpa": the product name for advanced, RNNoise-based noise
 * suppression (`client/src/lib/noise-suppression.ts`, `NoiseSuppressionMode
 * === "advanced"`). RNNoise itself is never named in the UI outside the
 * Settings description — see `docs/NOISE_SUPPRESSION.md`.
 *
 * This module holds the two things about it that have to be pure functions
 * to be tested without a DOM: whether the one-time nudge card is allowed to
 * show, and whether the NOVO dot in Settings is still owed.
 */

/**
 * The nudge is a `layout="inline"` `CornerCard`, same shell as every other
 * hint (`docs/ONBOARDING.md`), anchored above the user bar rather than the
 * bottom-right corner. It still goes through the corner queue
 * (`lib/corner-hints.ts`, `"voiceClean"`) so it can never be on screen at the
 * same time as another card — the priority sits after the first-run cards
 * and before the app-invite campaigns.
 *
 * Persisted per account (`preferences.voiceCleanNudgeDismissedAt`), not
 * localStorage: a new browser must not re-offer something already answered.
 * Below `VOICE_CLEAN_NUDGE_MIN_WIDTH_PX` the card does not show at all —
 * `docs/ONBOARDING.md` calls that "becomes a NOVO dot on the mic settings
 * entry" — the dot is `shouldShowVoiceCleanSettingsBadge` below, and stays
 * owed until a desktop session shows the card or Settings is opened once.
 */
export const VOICE_CLEAN_NUDGE_MIN_WIDTH_PX = 640;

export function shouldOfferVoiceCleanNudge(input: {
  /** `preferences.voiceCleanNudgeDismissedAt` is set. */
  dismissed: boolean;
  automated: boolean;
  /** `voiceState.status === "connected"`. */
  inCall: boolean;
  /** `!voiceState.isMuted`. */
  micOn: boolean;
  /** Sharing a screen in a `watch_party` channel. */
  presentingWatchParty: boolean;
  /** `window.innerWidth >= VOICE_CLEAN_NUDGE_MIN_WIDTH_PX`. */
  isDesktopViewport: boolean;
}): boolean {
  return (
    !input.dismissed &&
    !input.automated &&
    input.inCall &&
    input.micOn &&
    !input.presentingWatchParty &&
    input.isDesktopViewport
  );
}

/** The preference patch written on either button — both are an answer. */
export function voiceCleanNudgeDismissedPatch(
  now: Date = new Date(),
): { voiceCleanNudgeDismissedAt: string } {
  return { voiceCleanNudgeDismissedAt: now.toISOString() };
}

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
 * the nudge card was acted on (`preferences.voiceCleanNudgeDismissedAt`).
 * Whichever comes first, so someone who clicks "Ativar" from the nudge never
 * sees a dot pointing at a setting they just used.
 */
export function shouldShowVoiceCleanSettingsBadge(input: {
  settingsSeen: boolean;
  nudgeDismissed: boolean;
}): boolean {
  return !input.settingsSeen && !input.nudgeDismissed;
}
