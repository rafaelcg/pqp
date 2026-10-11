import { FORUM_ERRORS, type ForumConfig } from "@pqp/shared";
import { z } from "zod";
import { isEnabled } from "./flags.js";

/**
 * Whether forum channels are on for a server: the runtime flag
 * `forum_channels` (default off, per-server override, `FORUM_CHANNELS` as its
 * environment default). Served by `GET /api/forum/config?serverId=` and read
 * per request, so the operator's switch is answered by the very next call.
 *
 * Off gates CREATING: a forum channel, and (from forum PR 1) a post. It never
 * hides anything: forums that exist stay readable and repliable.
 *
 * `serverId` absent or not a uuid is read as absent, and the answer is the
 * global value (what the Discord import asks, since a new server has no
 * override yet).
 */
const serverIdSchema = z.string().uuid();

export function forumConfigForServer(rawServerId: string | null): ForumConfig {
  const parsed = serverIdSchema.safeParse(rawServerId);
  const serverId = parsed.success ? parsed.data : null;
  return { enabled: forumChannelsEnabled(serverId) };
}

export function forumChannelsEnabled(serverId: string | null): boolean {
  return isEnabled("forum_channels", { serverId });
}

/** The `error` token of the 403 a create answers while the flag is off. */
export const FORUM_CHANNELS_OFF = FORUM_ERRORS.off;
