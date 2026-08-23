import { z } from "zod";

/**
 * Linked gaming accounts — Discord-style Connections, not a second login.
 *
 * Clerk remains how you sign into pqp. Steam / Battle.net / Twitch are badges
 * on a profile, proven by sending the person through that platform's own
 * identity flow and storing the stable id that comes back. A SteamID in this
 * table is not a way into the account; disconnecting one does not sign anyone
 * out.
 *
 * WHY THESE THREE AND NOT XBOX / PSN. Steam OpenID 2.0 and the Battle.net /
 * Twitch authorization-code grants are self-serve: register an app, get a
 * key, done. Xbox Live and PlayStation are partner programmes. Shipping a
 * Connect button that 503s forever is worse than not offering it.
 *
 * Visibility is the whole privacy feature. Default `shared` (in-app card
 * only). `public` is an explicit extra tap, because a Steam profile URL on
 * `pqp.gg/@handle` is a stable identifier on the open internet and the rest
 * of that page was designed to not be one. See `docs/CONNECTIONS.md`.
 */

export const CONNECTION_PROVIDERS = ["steam", "battlenet", "twitch"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const connectionProviderSchema = z.enum(CONNECTION_PROVIDERS);

export const CONNECTION_VISIBILITIES = ["hidden", "shared", "public"] as const;
export type ConnectionVisibility = (typeof CONNECTION_VISIBILITIES)[number];

export const connectionVisibilitySchema = z.enum(CONNECTION_VISIBILITIES);

/** Default for a newly linked account: visible on the in-app card, not the public page. */
export const DEFAULT_CONNECTION_VISIBILITY: ConnectionVisibility = "shared";

export const CONNECTION_CALLBACK_PATH_PREFIX = "/app/connections/callback";

export function connectionCallbackPath(provider: ConnectionProvider): string {
  return `${CONNECTION_CALLBACK_PATH_PREFIX}/${provider}`;
}

/**
 * Pull the provider out of `/app/connections/callback/steam`. Null for any
 * other path — including a trailing extra segment, so a typo cannot be
 * silently coerced onto a real provider.
 */
export function connectionProviderFromPath(
  pathname: string,
): ConnectionProvider | null {
  const match = /^\/app\/connections\/callback\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  const parsed = connectionProviderSchema.safeParse(match[1]);
  return parsed.success ? parsed.data : null;
}

export const connectionConfigSchema = z.object({
  steam: z.boolean(),
  battlenet: z.boolean(),
  twitch: z.boolean(),
});

export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;

/**
 * Avatar and profile links we render as `href`. `z.string().url()` accepts
 * `javascript:`; the refine is what keeps that off a public page.
 */
const httpUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "Must be an http(s) URL");

/**
 * What the account holder sees in Settings, including hidden links and the
 * visibility they picked. `providerUserId` stays off every other payload —
 * a SteamID is an identifier, and Settings is the one surface that belongs
 * to the subject.
 */
export const ownConnectionSchema = z.object({
  provider: connectionProviderSchema,
  providerUserId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
  avatarUrl: httpUrlSchema.nullable(),
  profileUrl: httpUrlSchema.nullable(),
  visibility: connectionVisibilitySchema,
  connectedAt: z.string(),
});

export type OwnConnection = z.infer<typeof ownConnectionSchema>;

/**
 * What other people see. No provider user id: a Steam profile URL already
 * carries one if the subject chose to publish it, and inventing a second
 * copy would make "hidden" a lie.
 */
export const visibleConnectionSchema = z.object({
  provider: connectionProviderSchema,
  displayName: z.string().min(1).max(64),
  avatarUrl: httpUrlSchema.nullable(),
  profileUrl: httpUrlSchema.nullable(),
});

export type VisibleConnection = z.infer<typeof visibleConnectionSchema>;

export const startConnectionResponseSchema = z.object({
  url: z.string().url(),
});

export type StartConnectionResponse = z.infer<
  typeof startConnectionResponseSchema
>;

/**
 * The query string the provider bounced back with, posted by the SPA.
 *
 * Bounded both per-value and in key count so a stuffed callback cannot turn
 * this endpoint into an unbounded buffer. Steam OpenID sends about ten
 * `openid.*` fields; OAuth sends `code` + `state` (or `error`).
 */
export const completeConnectionSchema = z.object({
  params: z
    .record(z.string().max(64), z.string().max(2048))
    .refine((value) => Object.keys(value).length <= 40, "Too many callback parameters"),
});

export type CompleteConnectionRequest = z.infer<typeof completeConnectionSchema>;

export const updateConnectionSchema = z.object({
  visibility: connectionVisibilitySchema,
});

export type UpdateConnectionRequest = z.infer<typeof updateConnectionSchema>;

export const steamProfileUrl = (steamId: string): string =>
  `https://steamcommunity.com/profiles/${steamId}`;

export const twitchProfileUrl = (login: string): string =>
  `https://www.twitch.tv/${encodeURIComponent(login)}`;
