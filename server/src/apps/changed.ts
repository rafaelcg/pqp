import { publishToCluster, subscribeToCluster } from "../lib/bus.js";

/**
 * The hint an operator or owner change to app availability sends to every
 * sibling API instance, the same shape as `flags.changed` in `lib/flags.ts`.
 *
 * Availability (`flag apps` AND `apps.status` AND `apps.global_enabled` AND
 * `server_apps`, PLAN D10) is read from rows that an operator moves while
 * several API processes are serving. Anything that caches an answer to it must
 * drop that answer when this lands, instead of waiting out a TTL: an operator
 * who just switched an app off everywhere expects the next "start" on the
 * other machine to be refused now.
 *
 * `serverId` is null when the change is about the app as a whole (status,
 * global switch, community unlock, current version, a review), and the server
 * id when it is one server's switch. A listener that cannot be selective drops
 * everything; the payload only lets a careful one do less.
 *
 * Publishing is fire and forget and happens AFTER the transaction commits, so
 * a sibling that reloads on the frame reads the new rows.
 *
 * IT IS A HINT, NOT A GUARANTEE, the same contract as `flags.changed`: a
 * process that dies between the commit and the publish, or a bus that is
 * reconnecting, drops it. Whatever listens must therefore keep its own TTL as
 * the backstop (`FEATURE_FLAGS_TTL_MS` is the model), and today the availability
 * check reads the rows on every call and caches nothing, so a lost hint costs
 * nothing. A transactional outbox would buy certainty for a cache that does not
 * exist yet; if one is ever added, the TTL is the rule, not the frame.
 */
export const APPS_BUS_TOPIC = "apps.changed";

export interface AppsChangedHint {
  appId: string;
  serverId: string | null;
}

export function publishAppsChanged(hint: AppsChangedHint): void {
  publishToCluster(APPS_BUS_TOPIC, hint);
}

/**
 * Called on the SIBLINGS: `subscribeToCluster` never shows a process its own
 * frames. The process that took the write drops its own cache itself, in the
 * same request, before it answers (the way `lib/flags.ts` reloads locally and
 * then publishes).
 */
export function onAppsChanged(
  handler: (hint: AppsChangedHint, origin: string) => void,
): void {
  subscribeToCluster(APPS_BUS_TOPIC, (data, origin) => {
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { appId?: unknown }).appId === "string"
    ) {
      const { appId, serverId } = data as { appId: string; serverId?: unknown };
      handler(
        { appId, serverId: typeof serverId === "string" ? serverId : null },
        origin,
      );
    }
  });
}
