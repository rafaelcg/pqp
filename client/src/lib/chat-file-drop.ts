import { isVoiceRoomChannelType } from "@pqp/shared";
import type { FileDropMode } from "@/hooks/use-file-drop-zone";

/**
 * What a conversation does when a file is dragged over it, decided in one
 * place so the shell and the tests read the same rule.
 *
 * The shape matters more than the cases: a drop that is not accepted is either
 * `refuse` (we know why, and say so before the person lets go) or `off` (this
 * is not a place for files at all, and the page-wide guard keeps the browser
 * from opening the file instead). Never "ignore and hope", because ignoring a
 * drop is how a browser ends up navigating away from a call.
 */
export type ChatDropVerdict =
  | { mode: Extract<FileDropMode, "accept"> }
  | {
      mode: Extract<FileDropMode, "refuse">;
      reason: "attachmentsOff" | "cannotSend";
    }
  | { mode: Extract<FileDropMode, "off"> };

export function chatDropVerdict(input: {
  /** `null` until the config probe answers: unknown is not "disabled". */
  attachmentsEnabled: boolean | null;
  channelType: string;
  /**
   * The stream-chat composer of a watch party: one line and an emote picker,
   * with no attach control by design. A drop zone over a film would be the
   * only way to reach an attachment the composer does not offer.
   */
  streamChat: boolean;
  /** False only when we positively know this person may not post here. */
  canSend: boolean;
}): ChatDropVerdict {
  const isChat =
    input.channelType === "text" || isVoiceRoomChannelType(input.channelType);
  if (!isChat || input.streamChat || input.attachmentsEnabled === null) {
    return { mode: "off" };
  }
  if (!input.attachmentsEnabled) {
    return { mode: "refuse", reason: "attachmentsOff" };
  }
  if (!input.canSend) {
    return { mode: "refuse", reason: "cannotSend" };
  }
  return { mode: "accept" };
}
