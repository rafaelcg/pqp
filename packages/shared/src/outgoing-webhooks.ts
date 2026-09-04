import { z } from "zod";

/**
 * Outgoing channel webhooks: pqp POSTs a signed `message.created` event to
 * an HTTPS URL after a human message commits. Separate from incoming
 * `webhooks.ts` (Discord execute tokens) on purpose — the two are not the
 * same credential, permission, or table.
 */

export const OUTGOING_WEBHOOK_EVENT_TYPE = "message.created" as const;

export const OUTGOING_WEBHOOK_STATUSES = [
  "active",
  "disabled",
  "failing",
] as const;
export type OutgoingWebhookStatus = (typeof OUTGOING_WEBHOOK_STATUSES)[number];

/**
 * Extra headers a receiver (Grok Bot, a self-hosted worker) can ask us to
 * send. Names only: values never appear on list/get.
 */
export const OUTGOING_WEBHOOK_AUTH_HEADER_NAMES = [
  "Authorization",
  "X-Webhook-Secret",
  "X-Api-Key",
] as const;
export type OutgoingWebhookAuthHeaderName =
  (typeof OUTGOING_WEBHOOK_AUTH_HEADER_NAMES)[number];

export const outgoingWebhookAuthHeaderNameSchema = z.enum(
  OUTGOING_WEBHOOK_AUTH_HEADER_NAMES,
);

export const outgoingWebhookNameSchema = z.string().min(1).max(80);

/** Length only. HTTPS / SSRF / credentials are enforced on the server. */
export const outgoingWebhookUrlSchema = z.string().min(8).max(2048);

export const createOutgoingWebhookSchema = z
  .object({
    name: outgoingWebhookNameSchema,
    url: outgoingWebhookUrlSchema,
    channelIds: z.array(z.string().uuid()).min(1).max(100),
    skipUserIds: z.array(z.string().uuid()).max(100).optional(),
    authHeaderName: outgoingWebhookAuthHeaderNameSchema.nullable().optional(),
    authHeaderValue: z.string().min(1).max(512).nullable().optional(),
  })
  .refine(
    (body) =>
      Boolean(body.authHeaderName) ===
      Boolean(body.authHeaderValue && body.authHeaderValue.length > 0),
    { message: "Auth header name and value must be set together" },
  );
export type CreateOutgoingWebhookBody = z.infer<
  typeof createOutgoingWebhookSchema
>;

export const updateOutgoingWebhookSchema = z
  .object({
    name: outgoingWebhookNameSchema.optional(),
    url: outgoingWebhookUrlSchema.optional(),
    channelIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    skipUserIds: z.array(z.string().uuid()).max(100).optional(),
    authHeaderName: outgoingWebhookAuthHeaderNameSchema.nullable().optional(),
    authHeaderValue: z.string().min(1).max(512).nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine(
    (body) => {
      const nameSet = body.authHeaderName !== undefined;
      const valueSet = body.authHeaderValue !== undefined;
      if (!nameSet && !valueSet) {
        return true;
      }
      if (body.authHeaderName === null && body.authHeaderValue === null) {
        return true;
      }
      if (
        typeof body.authHeaderName === "string" &&
        typeof body.authHeaderValue === "string" &&
        body.authHeaderValue.length > 0
      ) {
        return true;
      }
      return false;
    },
    { message: "Auth header name and value must be set together" },
  );
export type UpdateOutgoingWebhookBody = z.infer<
  typeof updateOutgoingWebhookSchema
>;

export const outgoingWebhookAuthorSchema = z.object({
  id: z.string().uuid(),
  username: z.string().nullable(),
  tag: z.string().nullable(),
  displayName: z.string(),
  isBot: z.boolean(),
});

export const outgoingMessageCreatedPayloadSchema = z.object({
  type: z.literal(OUTGOING_WEBHOOK_EVENT_TYPE),
  id: z.string().uuid(),
  createdAt: z.string(),
  timestamp: z.string(),
  serverId: z.string().uuid(),
  serverName: z.string(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  messageId: z.string().uuid(),
  author: outgoingWebhookAuthorSchema,
  body: z.string(),
  replyToId: z.string().uuid().nullable(),
});
export type OutgoingMessageCreatedPayload = z.infer<
  typeof outgoingMessageCreatedPayloadSchema
>;

export const outgoingWebhookSkipUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  tag: z.string().nullable(),
});
export type OutgoingWebhookSkipUser = z.infer<
  typeof outgoingWebhookSkipUserSchema
>;

/**
 * Public webhook row. `signingSecret` is present only on create/rotate.
 * List/get never include the HMAC secret or the auth header value.
 */
export const outgoingWebhookSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  name: z.string(),
  url: z.string(),
  channelIds: z.array(z.string().uuid()),
  skipUserIds: z.array(z.string().uuid()),
  skipUsers: z.array(outgoingWebhookSkipUserSchema),
  secretHint: z.string(),
  authHeaderName: outgoingWebhookAuthHeaderNameSchema.nullable(),
  authHeaderHint: z.string().nullable(),
  status: z.enum(OUTGOING_WEBHOOK_STATUSES),
  lastError: z.string().nullable(),
  lastDeliveredAt: z.string().nullable(),
  disabledReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  signingSecret: z.string().optional(),
});
export type OutgoingWebhook = z.infer<typeof outgoingWebhookSchema>;
