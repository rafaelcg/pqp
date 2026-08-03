import { z } from "zod";

/**
 * A resolved preview of a link someone pasted into a message.
 *
 * `kind: 'image'` is a URL that IS the media (the fetch's own Content-Type
 * said so) and renders inline; `kind: 'link'` is an ordinary page and renders
 * as a card. `imageUrl` is never the origin site's own URL — the server
 * proxies it (see `GET /api/embeds/:urlHash/image`) so that rendering a
 * message never sends a viewer's IP to a host they did not choose to visit,
 * only ones they explicitly opened a link to.
 *
 * Every string here was extracted from HTML a stranger controls, so the caps
 * below are a second, independent bound on top of whatever truncation the
 * server already did when it stored the row — defence in depth for exactly
 * the field most likely to carry an attempted injection.
 */
export const embedKindSchema = z.enum(["link", "image"]);
export type EmbedKind = z.infer<typeof embedKindSchema>;

export const EMBED_TITLE_MAX_LENGTH = 256;
export const EMBED_DESCRIPTION_MAX_LENGTH = 400;
export const EMBED_SITE_NAME_MAX_LENGTH = 100;

export const embedSchema = z.object({
  url: z.string().url(),
  kind: embedKindSchema,
  title: z.string().max(EMBED_TITLE_MAX_LENGTH).nullable(),
  description: z.string().max(EMBED_DESCRIPTION_MAX_LENGTH).nullable(),
  siteName: z.string().max(EMBED_SITE_NAME_MAX_LENGTH).nullable(),
  imageUrl: z.string().url().nullable(),
  imageWidth: z.number().int().positive().nullable(),
  imageHeight: z.number().int().positive().nullable(),
});

export type Embed = z.infer<typeof embedSchema>;
