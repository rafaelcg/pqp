import { z } from "zod";
import { appManifestSchema, APP_CATEGORIES } from "./manifest.js";

/**
 * `GET /api/apps/config?serverId=`: what a client needs to draw the launcher
 * for one server and to run an app, never more. The server builds each entry
 * from the BUILT manifest it stored (`app_versions.manifest`), so nothing here
 * is supplied by a client and no app URL is ever taken from one.
 *
 * Server to client, so zod's default strip applies everywhere: a field a newer
 * server adds is dropped by an older client, not rejected.
 */

/**
 * Why an app is not available in one place, most fundamental first. The
 * launcher shows a disabled tile with the reason written (mock 01).
 *
 * - `flag-off`: the runtime flag `apps` is off for the server.
 * - `not-live`: the app is not `live` (draft, review, retired) or has no version.
 * - `global-off`: the operator's master switch for the app is off.
 * - `not-allowed-here`: the operator has not released it to this server.
 * - `owner-off`: the server's owner switched it off.
 * - `community-locked`: the server is a public community and the app has no
 *   safety decision for communities.
 * - `emulator-off`: an emulator app and the flag `emulator_room` is off here.
 * - `channel-type`: the channel's type is not one the app supports.
 * - `no-origin`: this deployment has no apps origin, so no app can run.
 */
export const APP_UNAVAILABLE_REASONS = [
  "flag-off",
  "not-live",
  "global-off",
  "not-allowed-here",
  "owner-off",
  "community-locked",
  "emulator-off",
  "channel-type",
  "no-origin",
] as const;
export const appUnavailableReasonSchema = z.enum(APP_UNAVAILABLE_REASONS);
export type AppUnavailableReason = (typeof APP_UNAVAILABLE_REASONS)[number];

const shape = appManifestSchema.shape;

/** One app, as the launcher and the runtime see it. */
export const appConfigEntrySchema = z
  .object({
    id: shape.id,
    version: shape.version,
    category: z.enum(APP_CATEGORIES),
    icon: shape.icon,
    /** i18n keys, resolved through `i18n` below. */
    name: shape.name,
    description: shape.description,
    notice: shape.notice,
    presence: shape.presence,
    channelTypes: shape.channelTypes,
    players: shape.players,
    /** What starting and joining need, so the launcher can say so before the click. */
    requires: shape.requires,
    /** The app's own caps, so the host enforces them and not only the platform's ceilings. */
    state: shape.state,
    events: shape.events,
    capabilities: shape.capabilities,
    content: shape.content,
    hostBound: shape.hostBound,
    /** Only the keys the client draws: name, description, notice, presence. */
    i18n: z.record(z.string(), z.record(z.string(), z.string())),
    /** Where the page loads the bundle from. `null` while there is no apps origin. */
    entry: z.object({ url: z.string().nullable() }).strip(),
    assets: z
      .array(
        z
          .object({
            name: z.string(),
            url: z.string().nullable(),
            sha256: z.string(),
            bytes: z.number().int().min(0),
          })
          .strip(),
      )
      .default([]),
    sandbox: shape.sandbox,
    available: z.boolean(),
    /** Null when `available`, otherwise why not. */
    reason: appUnavailableReasonSchema.nullable(),
    /**
     * Whether this app may share its pane and admit spectators here (D14:
     * emulator apps need the flag `locadora_share`). The client hides the
     * control when false; the server refuses either way.
     */
    shareAllowed: z.boolean(),
    /**
     * Saves na conta: true only for Locadora where `locadora_save_sync` is on
     * for this server. It changes what the join sheet says (the saves, never
     * the game, are kept on the account); the host still asks the API before
     * moving a byte. An older server sends nothing, which reads as false.
     */
    saveSync: z.boolean().default(false),
  })
  .strip();
export type AppConfigEntry = z.infer<typeof appConfigEntrySchema>;

export const appsConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** The apps origin (`APPS_ORIGIN`), or null when apps cannot run here. */
    origin: z.string().nullable(),
    apps: z.array(appConfigEntrySchema),
    /**
     * The runtime flag `app_pane_layout_v2` (global, default on): the call
     * keeps its controls in the column beside the app, the share picture is a
     * capped tile, and the chat can be put away. Only `false` turns it off; an
     * API from before the flag sends nothing, which a client reads as on.
     */
    paneLayoutV2: z.boolean().optional(),
  })
  .strip();
export type AppsConfig = z.infer<typeof appsConfigSchema>;

/**
 * `GET /api/public/apps/config`: what the signed-out pages of pqp Apps need,
 * identical for every caller and publicly cacheable for a minute.
 *
 * - `enabled`: the runtime flag `apps_landing` (the pages exist at all).
 * - `guest`: Locadora can be played without an account RIGHT NOW: `apps_landing`
 *   and `locadora_guest` are on, this deployment has an apps origin, and
 *   Locadora is `live` with the operator's master switch on and a valid stored
 *   manifest. Only then is `locadora` filled in.
 * - `cloudSaves`: the runtime flag `locadora_saves_announced`, which only
 *   decides whether the public copy may say "saves na nuvem". It turns nothing
 *   on; `locadora_save_sync` is per server and a visitor has none.
 * - `locadora`: the slice of the built manifest the guest player's frame host
 *   needs (bundle URL, assets with their hashes, capabilities, caps), built by
 *   the server from the stored manifest, never from a request. No i18n, no
 *   server, no session: a guest has none.
 *
 * An older API answers only `{ enabled }`; the defaults make that "no guest
 * play, no cloud-saves line", which is the safe reading.
 */
export const publicGuestAppSchema = z
  .object({
    id: shape.id,
    version: shape.version,
    entry: z.object({ url: z.string() }).strip(),
    capabilities: shape.capabilities,
    state: shape.state,
    events: shape.events,
    assets: z
      .array(
        z
          .object({
            name: z.string(),
            url: z.string(),
            sha256: z.string(),
            bytes: z.number().int().min(0),
          })
          .strip(),
      )
      .default([]),
  })
  .strip();
export type PublicGuestApp = z.infer<typeof publicGuestAppSchema>;

export const publicAppsConfigSchema = z
  .object({
    enabled: z.boolean(),
    guest: z.boolean().default(false),
    cloudSaves: z.boolean().default(false),
    locadora: z
      .object({ origin: z.string(), app: publicGuestAppSchema })
      .strip()
      .nullable()
      .default(null),
  })
  .strip();
export type PublicAppsConfig = z.infer<typeof publicAppsConfigSchema>;
