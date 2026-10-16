import { z } from "zod";

/**
 * THE ORDER OF THE SERVER RAIL, per person.
 *
 * `PUT /api/servers/order` saves the order one account drew by dragging its
 * own rail; `GET /api/servers` then returns the list in that order. Nothing
 * here is shared with other members: it is a fact about one account's view,
 * kept on that account's own `server_members` rows.
 *
 * The request carries the whole order the person sees, but the server treats it
 * as a statement of relative order, not as the truth about membership: an id
 * that is not one of the caller's servers (left or kicked since the tab last
 * looked) is dropped, and a server the caller holds that the request does not
 * name (joined since) goes after the named ones. So a stale tab can never
 * lock a server out of the list or fail with a 4xx for a race it cannot see.
 *
 * `origin` is a random string each tab invents once. It rides to the server
 * and comes back on the frame so the tab that saved can skip its own echo
 * instead of re-applying an order it already shows, which would otherwise
 * undo a second drag made while the first save was in the air.
 */
export const MAX_SERVER_ORDER_IDS = 500;

export const updateServerOrderSchema = z.object({
  serverIds: z
    .array(z.string().uuid())
    .max(MAX_SERVER_ORDER_IDS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "serverIds must not repeat",
    }),
  origin: z.string().min(1).max(64).optional(),
});
export type UpdateServerOrderRequest = z.infer<typeof updateServerOrderSchema>;

/**
 * Tells the account's OTHER tabs and devices what order the rail is in now.
 * Addressed per person on every socket they hold, never a channel fan-out.
 * `serverIds` is the full order as saved (only servers the account holds).
 */
export const serverOrderUpdateSchema = z.object({
  type: z.literal("server-order-update"),
  serverIds: z.array(z.string().uuid()),
  origin: z.string().max(64).optional(),
});
export type ServerOrderUpdate = z.infer<typeof serverOrderUpdateSchema>;

/**
 * Put `servers` in `order`'s order. Ids the order does not name keep their
 * relative order after the named ones (a server joined in another tab); ids it
 * names that the list does not hold are ignored. Pure, and shared so the web
 * and the tests agree on what "apply this order" means.
 */
export function applyServerOrder<T extends { id: string }>(
  servers: readonly T[],
  order: readonly string[],
): T[] {
  const byId = new Map(servers.map((server) => [server.id, server]));
  const out: T[] = [];
  for (const id of order) {
    const server = byId.get(id);
    if (server) {
      out.push(server);
      byId.delete(id);
    }
  }
  for (const server of servers) {
    if (byId.has(server.id)) {
      out.push(server);
    }
  }
  return out;
}
