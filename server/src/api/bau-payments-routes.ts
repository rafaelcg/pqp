import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  Permission,
  bauCheckoutBodySchema,
  bauPlanBodySchema,
  bauSandboxActionSchema,
} from "@pqp/shared";
import { HttpError, MAX_BODY_BYTES, readJsonBody, sendError, sendJson } from "../lib/http.js";
import type { Router } from "../lib/router.js";
import { memberHasPermission } from "../services/permissions.js";
import { getMemberRole } from "../services/users.js";
import { countBauPayments } from "../services/bau-payments/metrics.js";
import { getRegisteredProvider, isSandboxAllowed } from "../services/bau-payments/provider.js";
import {
  actOnSandboxAttempt,
  cancelBauAttempt,
  cancelBauMembership,
  connectSandboxPayout,
  getBauAttempt,
  getBauOffer,
  getBauPlanForStaff,
  handleProviderEvents,
  listMyMemberships,
  refundBauMembership,
  resumeBauMembership,
  startBauCheckout,
  upsertBauPlan,
} from "../services/bau-payments/service.js";

/**
 * BAÚ+ PAYMENTS over HTTP (`docs/BAU_PAYMENTS.md`). Web and desktop only:
 * the phone apps never call these (store policy), and nothing here is linked
 * from a phone surface.
 *
 * Fan
 *  - `GET  /api/servers/:serverId/bau-plus`                 the offer and my membership
 *  - `POST /api/servers/:serverId/bau-plus/checkout`        start or resume paying
 *  - `GET  /api/bau-plus/attempts/:attemptId[?refresh=1]`   the pay screen's poll
 *  - `POST /api/bau-plus/attempts/:attemptId/cancel`        drop an open code
 *  - `GET  /api/bau-plus/memberships`                       mine, with receipts
 *  - `POST /api/bau-plus/memberships/:membershipId/cancel`  stop renewing
 *  - `POST /api/bau-plus/memberships/:membershipId/resume`  undo that
 *  - `POST /api/bau-plus/memberships/:membershipId/refund`  the 7-day refund
 * Staff (MANAGE_SERVER)
 *  - `GET|PUT /api/servers/:serverId/bau-plus/plan`         the one plan
 *  - `POST    /api/servers/:serverId/bau-plus/sandbox/connect` (sandbox only)
 * Dev controls (sandbox only, the charge's own fan)
 *  - `POST /api/bau-plus/attempts/:attemptId/sandbox`       `{ action: pay | fail | expire }`
 * Provider, BEFORE auth (pitfall 8)
 *  - `POST /api/bau-plus/webhooks/:provider`                signature checked by the adapter
 */

async function requireMember(serverId: string, userId: string): Promise<void> {
  if (!(await getMemberRole(serverId, userId))) {
    throw new HttpError(404, "Server not found");
  }
}

async function requireManageServer(serverId: string, userId: string): Promise<void> {
  await requireMember(serverId, userId);
  if (!(await memberHasPermission(serverId, userId, Permission.MANAGE_SERVER))) {
    throw new HttpError(403, "You do not have permission to do that");
  }
}

const sandboxConnectSchema = z.object({
  sellerName: z.string().trim().min(1).max(80),
});
const sandboxActSchema = z.object({ action: bauSandboxActionSchema });

export function registerBauPaymentsRoutes(router: Router): void {
  router.get("/api/servers/:serverId/bau-plus", async ({ user }, { serverId }) => {
    await requireMember(serverId!, user.id);
    return getBauOffer(serverId!, user.id);
  });

  router.post("/api/servers/:serverId/bau-plus/checkout", async ({ req, user }, { serverId }) => {
    await requireMember(serverId!, user.id);
    const body = bauCheckoutBodySchema.parse(await readJsonBody(req));
    return startBauCheckout(serverId!, user.id, body);
  });

  router.get("/api/servers/:serverId/bau-plus/plan", async ({ user }, { serverId }) => {
    await requireManageServer(serverId!, user.id);
    return getBauPlanForStaff(serverId!);
  });

  router.put("/api/servers/:serverId/bau-plus/plan", async ({ req, user }, { serverId }) => {
    await requireManageServer(serverId!, user.id);
    const body = bauPlanBodySchema.parse(await readJsonBody(req));
    return { plan: await upsertBauPlan(serverId!, user.id, body) };
  });

  router.post(
    "/api/servers/:serverId/bau-plus/sandbox/connect",
    async ({ req, user }, { serverId }) => {
      if (!isSandboxAllowed()) {
        throw new HttpError(404, "Not found");
      }
      await requireManageServer(serverId!, user.id);
      const body = sandboxConnectSchema.parse(await readJsonBody(req));
      await connectSandboxPayout(serverId!, user.id, body.sellerName);
      return getBauPlanForStaff(serverId!);
    },
  );

  router.get("/api/bau-plus/memberships", async ({ user }) => ({
    memberships: await listMyMemberships(user.id),
  }));

  router.get("/api/bau-plus/attempts/:attemptId", async ({ url, user }, { attemptId }) =>
    getBauAttempt(attemptId!, user.id, { refresh: url.searchParams.get("refresh") === "1" }),
  );

  router.post("/api/bau-plus/attempts/:attemptId/cancel", async ({ user }, { attemptId }) =>
    cancelBauAttempt(attemptId!, user.id),
  );

  router.post("/api/bau-plus/attempts/:attemptId/sandbox", async ({ req, user }, { attemptId }) => {
    const body = sandboxActSchema.parse(await readJsonBody(req));
    return actOnSandboxAttempt(attemptId!, user.id, body.action);
  });

  router.post("/api/bau-plus/memberships/:membershipId/cancel", async ({ user }, { membershipId }) => ({
    membership: await cancelBauMembership(membershipId!, user.id),
  }));

  router.post("/api/bau-plus/memberships/:membershipId/resume", async ({ user }, { membershipId }) => ({
    membership: await resumeBauMembership(membershipId!, user.id),
  }));

  router.post("/api/bau-plus/memberships/:membershipId/refund", async ({ user }, { membershipId }) => ({
    membership: await refundBauMembership(membershipId!, user.id),
  }));
}

const WEBHOOK_PATH = /^\/api\/bau-plus\/webhooks\/([a-z0-9_-]{1,32})$/;

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The provider's notifications. Matched before the Bearer resolution, because
 * a provider has no session; the adapter's signature check is the only door.
 * A bad signature is 401 and counted; an apply that failed is 500 so the
 * provider retries (the event row was not marked processed); a duplicate is
 * 200 and does nothing.
 */
export async function handleBauPaymentsWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== "POST") {
    return false;
  }
  const match = WEBHOOK_PATH.exec(pathname);
  if (!match) {
    return false;
  }
  const provider = getRegisteredProvider(match[1]!);
  if (!provider || (provider.sandbox && !isSandboxAllowed())) {
    sendError(res, 404, "Not found", req);
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch {
    sendError(res, 413, "Request body too large", req);
    return true;
  }
  const events = provider.verifyWebhook(req.headers, raw);
  if (!events) {
    countBauPayments("webhooksBadSignature");
    sendError(res, 401, "Bad signature", req);
    return true;
  }
  try {
    const result = await handleProviderEvents(provider, events);
    sendJson(res, 200, { ok: true, ...result }, req);
  } catch (error) {
    console.error("[bau-payments] webhook apply failed:", error);
    sendError(res, 500, "Webhook not applied", req);
  }
  return true;
}
