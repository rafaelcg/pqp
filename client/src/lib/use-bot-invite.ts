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
    // Never carry the last server's answer onto this one while it loads.
    setOffer(false);
    if (!serverId || !canManageServer) {
      return;
    }
    let live = true;
    // The config is cheap and answers "bots are off" for most servers; the
    // list (which carries persona and knowledge) is fetched only past it.
    void fetchBotsConfig(serverId)
      .then(async (config) => {
        if (!config.enabled) return false;
        const list = await fetchServerBots(serverId);
        return list.bots.length < config.maxBots;
      })
      .then((next) => {
        if (live) setOffer(next);
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
