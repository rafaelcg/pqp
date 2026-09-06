import type { Channel, VoiceRoomTransport } from "@pqp/shared";
import type { MessageKey } from "@/lib/i18n";

export const CHANNEL_ICON_PRESETS = ["📡", "💬", "🔊", "🎮", "☕", "🛠️", "🎵", "📌"];

/**
 * The voice room size control, as the `<select>` sees it. The wire value is
 * `null | "mesh" | "livekit"`; a `<select>` only speaks strings, so "auto" is
 * the form's spelling of null.
 */
export const VOICE_ROOM_SIZE_OPTIONS = ["auto", "mesh", "livekit"] as const;
export type VoiceRoomSizeOption = (typeof VOICE_ROOM_SIZE_OPTIONS)[number];

export function toVoiceRoomSizeOption(
  transport: VoiceRoomTransport | null | undefined,
): VoiceRoomSizeOption {
  return transport ?? "auto";
}

export function fromVoiceRoomSizeOption(
  option: VoiceRoomSizeOption,
): VoiceRoomTransport | null {
  return option === "auto" ? null : option;
}

/** Only a server voice channel has a room to size; conversations are always small. */
export function showsVoiceRoomSize(
  channel: Pick<Channel, "kind" | "type"> | null,
): boolean {
  return channel?.kind === "server" && channel.type === "voice";
}

/**
 * `null` means the field is fine as it stands — either empty, an emoji/short
 * label, or an `https://` URL. Anything else that is shaped like a URL is
 * rejected. A channel image is rendered to everyone in the server.
 */
export function validateChannelIconInput(value: string): MessageKey | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "channel.meta.image.error.invalid";
  }
  if (parsed.protocol !== "https:") {
    return "channel.meta.image.error.httpsOnly";
  }
  return null;
}
