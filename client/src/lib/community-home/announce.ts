import type { Channel } from "@pqp/shared";

/**
 * Where a Baú post can be announced: the text channels of this server the
 * caller may speak in, and which of them is "the main one".
 *
 * The server decides for real (the chat's own send path refuses a channel the
 * caller cannot speak in, and an announce that fails never fails a publish);
 * this only keeps the picker honest and picks a sensible default.
 */

/** Names people give the room everyone is in. Emoji and separators ignored. */
const MAIN_CHANNEL_NAME =
  /^(geral|general|chat|chat-geral|lobby|principal|main|bate-papo|papo|bem-vindos|welcome)$/;

function plainName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function shareableChannels(
  channels: readonly Channel[],
  canSend: (channelId: string) => boolean = () => true,
): Channel[] {
  return channels
    .filter(
      (channel) =>
        channel.kind === "server" &&
        channel.type === "text" &&
        canSend(channel.id),
    )
    .sort((a, b) => a.position - b.position);
}

/** The server's general channel if it has one, else the first text channel. */
export function pickAnnounceChannel(
  channels: readonly Channel[],
  canSend: (channelId: string) => boolean = () => true,
): Channel | null {
  const candidates = shareableChannels(channels, canSend);
  return (
    candidates.find((channel) => MAIN_CHANNEL_NAME.test(plainName(channel.name))) ??
    candidates.find((channel) => !channel.isPrivate) ??
    candidates[0] ??
    null
  );
}
