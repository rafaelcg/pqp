import type { IncomingMessage } from "node:http";
import { readJsonBody } from "../lib/http.js";
import {
  appServersQuery,
  listAppServersForOperator,
  listAppsForOperator,
  operatorReviewAppVersion,
  operatorSetApp,
  operatorSetServerApp,
  reviewAppVersionSchema,
  setAppSchema,
  setServerAppSchema,
  type AppAdminActor,
} from "../apps/admin.js";

/**
 * THE OPERATOR'S APPS ROUTES (PLAN Phase 5), reachable two ways, exactly like
 * the flags and the watch party levers: an instance moderator's Clerk session
 * (`router` in `api/index.ts`) and the dashboard's machine token
 * (`ADMIN_MACHINE_ROUTES`, the same file).
 *
 * EXACT PATHNAMES, THE TARGET IN THE BODY OR THE QUERY. The machine token's
 * allowlist is a table of exact (method, path) pairs on purpose
 * (`operator.ts`: a pattern is a thing somebody widens by accident), so the app
 * id travels in the body (`PUT /api/admin/apps {appId, ...}`) the way a flag key
 * does in `PUT /api/admin/flags`, and not as `/api/admin/apps/:id`.
 *
 * Every handler takes the actor so the audit row says who: `dashboard` for the
 * token (no account, a NULL user), `moderator` plus the user id for a session.
 */

export const ADMIN_APPS_PATH = "/api/admin/apps";
export const ADMIN_APP_REVIEW_PATH = "/api/admin/app-review";
export const ADMIN_APP_SERVERS_PATH = "/api/admin/app-servers";
export const ADMIN_SERVER_APPS_PATH = "/api/admin/server-apps";

export async function adminListApps(): Promise<unknown> {
  return listAppsForOperator();
}

export async function adminSetApp(
  req: IncomingMessage,
  actor: AppAdminActor,
): Promise<unknown> {
  return operatorSetApp(setAppSchema.parse(await readJsonBody(req)), actor);
}

export async function adminReviewAppVersion(
  req: IncomingMessage,
  actor: AppAdminActor,
): Promise<unknown> {
  return operatorReviewAppVersion(
    reviewAppVersionSchema.parse(await readJsonBody(req)),
    actor,
  );
}

export async function adminListAppServers(query: URLSearchParams): Promise<unknown> {
  return listAppServersForOperator(appServersQuery(query));
}

export async function adminSetServerApp(
  req: IncomingMessage,
  actor: AppAdminActor,
): Promise<unknown> {
  return operatorSetServerApp(
    setServerAppSchema.parse(await readJsonBody(req)),
    actor,
  );
}
