import { z } from "zod";
import { appEndReasonSchema, appResultSchema } from "./common.js";

/**
 * What a timeline card needs about its session, carried on every message whose
 * `systemKind` is `app_session` (`messageSchema.appSession`): joined by the
 * server through `app_sessions.timeline_message_id`, so a client draws the card
 * live or as the quiet record from the message alone and never has to guess the
 * session by timestamps. `null` once the session row has been retained away
 * (30 days after it ended). Absent on every other message.
 *
 * Server to client, so zod's default strip applies.
 */
export const messageAppSessionSchema = z
  .object({
    id: z.string().uuid(),
    appId: z.string(),
    appVersion: z.string(),
    status: z.enum(["live", "ended"]),
    endReason: appEndReasonSchema.nullable(),
    summary: z
      .object({
        participants: z.number().int().min(0),
        durationSeconds: z.number().int().min(0),
        result: appResultSchema,
      })
      .strip()
      .nullable(),
    startedBy: z.string().uuid().nullable(),
  })
  .strip();
export type MessageAppSession = z.infer<typeof messageAppSessionSchema>;
