import { z } from "zod";
import { appsConfigForServer, DISABLED_APPS_CONFIG } from "../apps/config.js";
import { HttpError } from "../lib/http.js";
import type { Router } from "../lib/router.js";
import { getMemberRole } from "../services/users.js";

/**
 * THE APPS PLATFORM'S ROUTES (docs/APPS.md), mounted from `api/index.ts` with
 * `registerAppRoutes(router)`. Authenticated like every router route: the
 * Bearer is resolved before they run.
 *
 * Behind the runtime flag `apps` (per server, default off). The config route
 * answers the flag off with a quiet `{ enabled: false }` so a client hides the
 * launcher; every other route here answers 404 while the flag is off for the
 * server it names, exactly as if the path did not exist.
 */

const serverIdSchema = z.string().uuid();

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
}
