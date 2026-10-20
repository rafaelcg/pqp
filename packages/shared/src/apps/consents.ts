import { z } from "zod";

/**
 * `GET /api/me/app-consents`: what one person has accepted, per app (mock 04,
 * `app_consents`). Server to client, so zod's default strip applies: a field a
 * newer server adds is dropped by an older client, not rejected.
 *
 * `stale` is true when the app's current version asks for something the
 * accepted one did not (a capability diff), and the join sheet shows again.
 * `names` and `notices` are the app's own words for the list in Configurações,
 * per locale.
 */
export const appConsentSchema = z
  .object({
    appId: z.string(),
    acceptedVersion: z.string(),
    identityGranted: z.boolean(),
    consentedAt: z.string(),
    identity: z.enum(["display", "user-id"]),
    names: z.record(z.string(), z.string()).default({}),
    notices: z.record(z.string(), z.string()).default({}),
    stale: z.boolean().default(false),
  })
  .strip();
export type AppConsent = z.infer<typeof appConsentSchema>;

/** `POST /api/apps/:app/consent`: the only body. Client to server, so strict. */
export const appConsentBodySchema = z
  .object({ identityGranted: z.boolean().optional() })
  .strict();
