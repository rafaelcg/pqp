import type { CommunityHomeConfig } from "@pqp/shared";
import { fetchCommunityHomeConfig } from "@/lib/api";

/**
 * The instance's Baú flags, asked once per page load.
 *
 * Same memoised-probe shape as `loadAttachmentConfig`: App awaits it before
 * choosing where a server lands (Home or first text channel), and the feed
 * reads the same promise for `vipEnabled` / `mediaEnabled`. A failed probe
 * reads as everything off, which is the only safe answer for a surface that
 * should look absent until the API says otherwise.
 */

export const COMMUNITY_HOME_CONFIG_OFF: CommunityHomeConfig = {
  enabled: false,
  vipEnabled: false,
  mediaEnabled: false,
};

let probe: Promise<CommunityHomeConfig> | null = null;

export function loadCommunityHomeConfig(): Promise<CommunityHomeConfig> {
  probe ??= fetchCommunityHomeConfig()
    .then((config) => ({
      enabled: config.enabled === true,
      vipEnabled: config.enabled === true && config.vipEnabled === true,
      mediaEnabled: config.enabled === true && config.mediaEnabled === true,
    }))
    .catch(() => COMMUNITY_HOME_CONFIG_OFF);
  return probe;
}

/** Tests only: forget the cached answer. */
export function resetCommunityHomeConfigProbe(): void {
  probe = null;
}
