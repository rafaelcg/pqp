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

/**
 * Whether the VIP half is on for ONE server (`community_home_vip` is a
 * per-server runtime flag, so the boot probe above, which names no server,
 * cannot answer it for a pilot server). Not memoised: the feed asks when it
 * opens, so the operator's flip is seen on the next open. Off on any failure.
 */
export async function loadCommunityHomeVipEnabled(
  serverId: string,
): Promise<boolean> {
  try {
    const config = await fetchCommunityHomeConfig(serverId);
    return config.enabled === true && config.vipEnabled === true;
  } catch {
    return false;
  }
}

/** Tests only: forget the cached answer. */
export function resetCommunityHomeConfigProbe(): void {
  probe = null;
}
