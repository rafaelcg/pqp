import { z } from "zod";

/**
 * Discord's own limits on an embed, mirrored so a payload built for a real
 * Discord webhook already fits here unchanged — that compatibility is the
 * entire point of this feature.
 */
export const webhookEmbedFieldSchema = z.object({
  name: z.string().max(256),
  value: z.string().max(1024),
  inline: z.boolean().optional(),
});

/**
 * A deliberate subset of Discord's embed object: title, description, url,
 * color, fields, footer, and timestamp cover the overwhelming majority of
 * real webhook traffic (CI results, GitHub events, monitoring alerts).
 * Author/image/thumbnail/video/provider are not implemented — a payload
 * that includes them still works, those fields are just ignored rather
 * than rejected.
 */
export const webhookEmbedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  url: z.string().url().optional(),
  /** A packed 24-bit RGB integer, the same encoding Discord's own embeds use. */
  color: z.number().int().min(0).max(0xffffff).optional(),
  fields: z.array(webhookEmbedFieldSchema).max(25).optional(),
  footer: z.object({ text: z.string().max(2048) }).optional(),
  timestamp: z.string().optional(),
});
export type WebhookEmbed = z.infer<typeof webhookEmbedSchema>;

export const MESSAGE_CONTENT_MAX_LENGTH = 2000;
export const MAX_WEBHOOK_EMBEDS = 10;

/**
 * The execute body, in Discord's own wire format — deliberately snake_case
 * and deliberately not reshaped to this codebase's usual camelCase, because
 * an external service sends exactly this shape without knowing pqp exists.
 * `content` or at least one embed is required, matching Discord's own rule
 * that an empty message is not a message.
 */
export const executeWebhookSchema = z
  .object({
    content: z.string().max(MESSAGE_CONTENT_MAX_LENGTH).optional(),
    username: z.string().min(1).max(80).optional(),
    avatar_url: z.string().url().optional(),
    embeds: z.array(webhookEmbedSchema).max(MAX_WEBHOOK_EMBEDS).optional(),
  })
  .refine(
    (body) => Boolean(body.content?.trim()) || (body.embeds?.length ?? 0) > 0,
    { message: "A webhook message needs content or at least one embed" },
  );
export type ExecuteWebhookBody = z.infer<typeof executeWebhookSchema>;

export const webhookSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  /**
   * The executable path, token included — `/api/webhooks/:id/:token`, not a
   * full URL, since the server does not know its own public origin and the
   * client already does (`getApiBaseUrl()`, the same way an embed's proxied
   * image path is resolved). Only ever sent to someone who already has
   * `requireManager` on this channel's server — the same trust boundary that
   * already gates seeing (and thus being able to rotate) every other secret
   * this API hands back.
   */
  url: z.string(),
  createdAt: z.string(),
});
export type Webhook = z.infer<typeof webhookSchema>;

export const createWebhookSchema = z.object({
  name: z.string().min(1).max(80),
  avatarUrl: z.string().url().nullable().optional(),
});
