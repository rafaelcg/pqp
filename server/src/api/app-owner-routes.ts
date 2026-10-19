import { Permission } from "@pqp/shared";
import { listOwnerApps, setOwnerApp, setOwnerAppSchema } from "../apps/owner.js";
import { isEnabled } from "../lib/flags.js";
import { HttpError, readJsonBody } from "../lib/http.js";
import type { Router } from "../lib/router.js";
import { memberHasPermission } from "../services/permissions.js";
import { getMemberRole } from "../services/users.js";

/**
 * THE OWNER'S APPS SWITCHES (`apps/owner.ts`), mounted from `api/index.ts` with
 * `registerAppOwnerRoutes(router)`:
 *
 *  - `GET /api/servers/:serverId/apps`  the apps the operator released here, each with the owner's switch
 *  - `PUT /api/servers/:serverId/apps`  `{ appId, ownerEnabled: false | null }`
 *
 * Both need MANAGE_SERVER (the owner holds every bit), and both answer 404 while
 * the `apps` flag is off for the server, like every route of the platform: the
 * settings section is hidden by the client from the same flag. A caller who is
 * not a member gets the 404 of any server route, a member without the bit a 403.
 */

async function requireOwnerAccess(serverId: string, userId: string): Promise<void> {
  if (!(await getMemberRole(serverId, userId))) {
    throw new HttpError(404, "Server not found");
  }
  if (!isEnabled("apps", { serverId })) {
    throw new HttpError(404, "Server not found");
  }
  if (!(await memberHasPermission(serverId, userId, Permission.MANAGE_SERVER))) {
    throw new HttpError(403, "You do not have permission to do that");
  }
}

export function registerAppOwnerRoutes(router: Router): void {
  router.get("/api/servers/:serverId/apps", async ({ user }, { serverId }) => {
    await requireOwnerAccess(serverId!, user.id);
    return listOwnerApps(serverId!);
  });

  router.put("/api/servers/:serverId/apps", async ({ req, user }, { serverId }) => {
    await requireOwnerAccess(serverId!, user.id);
    return setOwnerApp(serverId!, user.id, setOwnerAppSchema.parse(await readJsonBody(req)));
  });
}
