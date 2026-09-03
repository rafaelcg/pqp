/**
 * Synthetic id for the Community Home surface.
 *
 * NOT A REAL CHANNEL. It never hits the API, never appears in `channels`, and
 * must not be passed to `openChannel` / `fetchMessages`. The channel list and
 * the main pane treat it as a local selection only while the experiment flag
 * is on.
 */
export const COMMUNITY_HOME_CHANNEL_ID = "__community_home__";

export function isCommunityHomeChannelId(
  channelId: string | null | undefined,
): boolean {
  return channelId === COMMUNITY_HOME_CHANNEL_ID;
}
