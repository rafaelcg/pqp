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
  })
  .strip();
export type AppConfigEntry = z.infer<typeof appConfigEntrySchema>;

export const appsConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** The apps origin (`APPS_ORIGIN`), or null when apps cannot run here. */
    origin: z.string().nullable(),
    apps: z.array(appConfigEntrySchema),
  })
  .strip();
export type AppsConfig = z.infer<typeof appsConfigSchema>;
