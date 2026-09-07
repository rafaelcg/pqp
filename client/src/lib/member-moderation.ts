import { TIMEOUT_PRESET_MINUTES } from "@pqp/shared";
import type { ProfileModerationAction } from "@/components/user/profile-relations";
import { banMember, kickMember, liftTimeout, timeoutMember } from "@/lib/api";
import type { Translator } from "@/lib/i18n";

/**
 * One rung of the ladder, run.
 *
 * WHY IT LIVES HERE. The ladder is reachable from three places now: the
 * profile card, the member list's own context menu and the moderation panel,
 * and every one of them wants the same four calls with the same arguments. A
 * second copy of "which endpoint does a ban go to, and does it carry a reason"
 * is exactly the code that drifts: the panel already dropped the ban reason on
 * the floor for months while the card kept it.
 *
 * The UI around this (a duration to pick, a confirmation to give) stays with
 * each surface, because those differ on purpose: the card composes inline so
 * the moderator keeps looking at the message that prompted it, and the member
 * list has no room to expand a row so it opens a dialog.
 */
export interface MemberModerationInput {
  action: ProfileModerationAction;
  serverId: string;
  userId: string;
  /** Timeouts only. Defaults to the second preset. */
  minutes?: number | null;
  /** Timeouts and bans. Trimmed by the caller; empty means none. */
  reason?: string | null;
}

/** The default a timeout composer opens on. */
export const DEFAULT_TIMEOUT_MINUTES = TIMEOUT_PRESET_MINUTES[1]!;

/**
 * Runs it and hands back the sentence to show, when the server writes one.
 *
 * A timeout is the only action whose result is a sentence rather than a fact:
 * the server composes when it ends and what it takes away, and it is the SAME
 * string the sanctioned person reads. Showing it verbatim is how the two sides
 * cannot disagree about what was done.
 */
export async function applyMemberModeration(
  input: MemberModerationInput,
): Promise<string | null> {
  const { action, serverId, userId } = input;
  const reason = input.reason?.trim() || null;
  switch (action) {
    case "timeout": {
      const { message } = await timeoutMember(
        serverId,
        userId,
        input.minutes ?? DEFAULT_TIMEOUT_MINUTES,
        reason,
      );
      return message;
    }
    case "endTimeout":
      await liftTimeout(serverId, userId);
      return null;
    case "kick":
      await kickMember(serverId, userId);
      return null;
    case "ban":
      // The reason the members panel drops on the floor. It is the only thing
      // the ban list can show later about *why*, and a ban with no reason is a
      // decision nobody, including the person who made it, can reconstruct
      // in six months.
      await banMember(serverId, userId, reason);
      return null;
  }
}

/**
 * A preset's label. Translated per unit rather than formatted from a number,
 * because "1 day" and "7 days" pluralise differently in the languages this
 * catalogue already carries, and the presets are a fixed list of four.
 */
export function describeTimeoutMinutes(
  minutes: number,
  t: Translator["t"],
): string {
  if (minutes < 60) {
    return t("profile.mod.duration.minutes", { count: minutes });
  }
  if (minutes < 60 * 24) {
    return t("profile.mod.duration.hours", { count: minutes / 60 });
  }
  return t("profile.mod.duration.days", { count: minutes / (60 * 24) });
}

/** The label for a rung, shared by every surface that lists them. */
export function moderationActionLabel(
  action: ProfileModerationAction,
  t: Translator["t"],
): string {
  switch (action) {
    case "timeout":
      return t("profile.mod.timeout");
    case "endTimeout":
      return t("profile.mod.endTimeout");
    case "kick":
      return t("profile.mod.kick");
    case "ban":
      return t("profile.mod.ban");
  }
}
