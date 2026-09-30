import type { VoiceModerationMessage } from "@pqp/shared";
import type { MessageKey, MessageVars } from "@/lib/i18n/instance";

type Translate = (key: MessageKey, vars?: MessageVars) => string;

/**
 * The banner for a `voice-moderation` frame, in the person's language.
 *
 * The frame carries a fixed English sentence, so the client picks its own copy
 * from `action` and `reason`. `message` is only the fallback for an action a
 * newer server may add, so a banner is never blank.
 *
 * `movedToChannelName` is the destination's name when this client knows it.
 * The frame names it only inside the English sentence, and the destination may
 * be a channel of a server this client has not loaded.
 */
export function voiceModerationNotice(
  message: VoiceModerationMessage,
  movedToChannelName: string | undefined,
  t: Translate,
): string {
  switch (message.action) {
    case "muted":
      return t("voice.serverMuted.self");
    case "unmuted":
      return t("voice.serverMuted.cleared");
    case "disconnected":
      return message.reason === "idle"
        ? t("voice.idle.disconnected", { count: message.aloneMinutes ?? 10 })
        : t("voice.moderation.disconnected");
    case "moved":
      return movedToChannelName
        ? t("voice.moderation.moved", { name: movedToChannelName })
        : t("voice.moderation.movedGeneric");
    default:
      return message.message;
  }
}
