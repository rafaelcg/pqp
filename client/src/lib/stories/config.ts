import {
  STORY_MAX_BYTES,
  STORY_MAX_VIDEO_MS,
  STORY_TTL_HOURS,
  type StoriesConfig,
} from "@pqp/shared";
import { fetchStoriesConfig } from "./api";

/**
 * The deployment's stories answers, asked once per page load (the shape of
 * `loadCommunityHomeConfig`). A failed probe reads as everything off, the
 * only safe answer for a surface that should look absent until the API says
 * otherwise.
 *
 * `enabled` here is the deployment-wide value and is NOT what decides whether
 * a server draws its strip: one server can be on while the deployment is off
 * (that is how the QG goes first). The strip route answers that per server.
 * What this is for: `friendsEnabled`, and the limits the composer checks a
 * file against before uploading it.
 */

export const STORIES_CONFIG_OFF: StoriesConfig = {
  enabled: false,
  friendsEnabled: false,
  mediaEnabled: false,
  videoEnabled: false,
  maxVideoMs: STORY_MAX_VIDEO_MS,
  maxBytes: STORY_MAX_BYTES,
  ttlHours: STORY_TTL_HOURS,
};

let probe: Promise<StoriesConfig> | null = null;

export function loadStoriesConfig(): Promise<StoriesConfig> {
  probe ??= fetchStoriesConfig()
    .then((config) => ({
      ...STORIES_CONFIG_OFF,
      ...config,
      friendsEnabled: config.friendsEnabled === true,
      mediaEnabled: config.mediaEnabled === true,
      videoEnabled: config.mediaEnabled === true && config.videoEnabled === true,
    }))
    .catch(() => {
      // Let the next caller ask again: a blip at boot must not switch stories
      // off for the whole session.
      probe = null;
      return STORIES_CONFIG_OFF;
    });
  return probe;
}

/** Per server, for the role editor: is there a stories feature to configure here? */
const serverProbes = new Map<string, Promise<boolean>>();

export function loadServerStoriesEnabled(serverId: string): Promise<boolean> {
  let pending = serverProbes.get(serverId);
  if (!pending) {
    pending = fetchStoriesConfig(serverId)
      .then((config) => config.enabled === true)
      .catch(() => {
        serverProbes.delete(serverId);
        return false;
      });
    serverProbes.set(serverId, pending);
  }
  return pending;
}

/** Tests only. */
export function resetStoriesConfigProbe(): void {
  probe = null;
  serverProbes.clear();
}
