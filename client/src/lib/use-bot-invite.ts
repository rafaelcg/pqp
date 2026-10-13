import { useEffect, useState } from "react";
import { fetchBotsConfig, fetchServerBots } from "@/lib/api";

/**
 * Whether to offer "create a bot" in the member list: staff who can manage the
 * server, on a server where bots are on, that has none yet. Asked again when
 * `refresh` changes (the wizard closing), so the row goes once the bot exists.
 */
export function useBotInvite(
  serverId: string | null,
  canManageServer: boolean,
  refresh: unknown,
): boolean {
  const [offer, setOffer] = useState(false);
  useEffect(() => {
    if (!serverId || !canManageServer) {
      setOffer(false);
      return;
    }
    let live = true;
    void Promise.all([fetchBotsConfig(serverId), fetchServerBots(serverId)])
      .then(([config, list]) => {
        if (live) setOffer(config.enabled && list.bots.length < config.maxBots);
      })
      .catch(() => {
        if (live) setOffer(false);
      });
    return () => {
      live = false;
    };
  }, [serverId, canManageServer, refresh]);
  return offer;
}
