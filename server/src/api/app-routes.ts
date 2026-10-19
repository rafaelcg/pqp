import { z } from "zod";
import { appsConfigForServer, DISABLED_APPS_CONFIG } from "../apps/config.js";
import { endAppSessionAs, startAppSession } from "../apps/sessions.js";
import { readLiveSummariesForServer, readLiveSummary } from "../apps/summary.js";
import { isEnabled } from "../lib/flags.js";
import { HttpError, readJsonBody } from "../lib/http.js";
import { Created } from "../lib/route-results.js";
import type { Router } from "../lib/router.js";
import { getChannel } from "../services/servers.js";
import { accessibleChannelIds, canAccessChannel, getMemberRole } from "../services/users.js";

/**
 * THE APPS PLATFORM'S ROUTES (docs/APPS.md), mounted from `api/index.ts` with
 * `registerAppRoutes(router)`. Authenticated like every router route: the
 * Bearer is resolved before they run.
 *
 * Behind the runtime flag `apps` (per server, default off). The config route
 * answers the flag off with a quiet `{ enabled: false }` so a client hides the
 * launcher; every other route here answers 404 while the flag is off for the
 * server it names, exactly as if the path did not exist.
 *
 *  - `GET  /api/apps/config?serverId=`         the launcher's list (see `apps/config.ts`)
 *  - `POST /api/channels/:channelId/app-sessions`   `{ appId }` -> 201 `AppSessionSummary`
 *  - `GET  /api/channels/:channelId/app-session`    `AppSessionSummary` or `null`
 *  - `POST /api/app-sessions/:sessionId/end`        -> 200 `{ ended }`
 *  - `GET  /api/servers/:serverId/app-sessions`     `{ sessions: [{ channelId, session }] }`
 *
 * The summaries are the `channel-app` frame's, so a client keeps one shape.
 */

const serverIdSchema = z.string().uuid();
const startBodySchema = z.object({
  appId: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/),
});

const notFoundChannel = () => new HttpError(404, "Channel not found");

export function registerAppRoutes(router: Router): void {
  // What a client needs to draw the launcher and run an app for one server.
  // A missing or malformed `serverId` is the disabled answer (nothing to ask
  // about); a server the caller is not in is a 404 like every server route.
  router.get("/api/apps/config", async ({ url, user }) => {
    const parsed = serverIdSchema.safeParse(url.searchParams.get("serverId"));
    if (!parsed.success) {
      return DISABLED_APPS_CONFIG;
    }
    if (!(await getMemberRole(parsed.data, user.id))) {
      throw new HttpError(404, "Server not found");
    }
    return appsConfigForServer(parsed.data);
  });

  // Start an app in a channel. Checks, in order, and what each answers:
  // `apps/sessions.ts` `startAppSession`. The server id is never read from the
  // body: the channel row says which server this is.
  router.post("/api/channels/:channelId/app-sessions", async ({ req, user }, { channelId }) => {
    const body = startBodySchema.parse(await readJsonBody(req));
    return new Created(await startAppSession(user, channelId!, body.appId));
  });

  // The live app of one channel, or `null`.
  router.get("/api/channels/:channelId/app-session", async ({ user }, { channelId }) => {
    const channel = await getChannel(channelId!);
    if (
      !channel ||
      channel.kind !== "server" ||
      !channel.server_id ||
      !(await canAccessChannel(channelId!, user.id)) ||
      !isEnabled("apps", { serverId: channel.server_id })
    ) {
      throw notFoundChannel();
    }
    return readLiveSummary(channelId!);
  });

  // End a session. Idempotent: ending one that is over answers 200 `{ ended: false }`.
  router.post("/api/app-sessions/:sessionId/end", async ({ user }, { sessionId }) => {
    return { ended: (await endAppSessionAs(user, sessionId!)).ended };
  });

  // Every live app on a server, for the channels the caller can VIEW. The
  // client asks on server open and on socket reconnect; the `/ws` welcome
  // carries none of it (a reconnect herd must not fan out per room).
  router.get("/api/servers/:serverId/app-sessions", async ({ user }, { serverId }) => {
    if (!(await getMemberRole(serverId!, user.id)) || !isEnabled("apps", { serverId })) {
      throw new HttpError(404, "Server not found");
    }
    const live = await readLiveSummariesForServer(serverId!);
    const visible = await accessibleChannelIds(
      live.map((entry) => entry.channelId),
      user.id,
    );
    return {
      sessions: live
        .filter((entry) => visible.has(entry.channelId))
        .map((entry) => ({ channelId: entry.channelId, session: entry.summary })),
    };
  });
}
