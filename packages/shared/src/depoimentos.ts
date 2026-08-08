import { z } from "zod";
import { publicUserSchema, safeTextSchema } from "./api.js";

/**
 * Depoimentos — the wire contract for the one feature in this product whose
 * mechanic is an ACT OF APPROVAL rather than an act of publishing.
 *
 * A friend writes a short thing about you. It lands in your queue, invisible to
 * everyone — including them, after sending — until you publish it. Published
 * ones sit on your profile, newest first, and you can take any of them down at
 * any time without telling anybody. `docs/research/communities-orkut.html` §05
 * is the full argument; the three rules that shape everything below are:
 *
 * 1. ONLY FRIENDS WRITE. The same `areFriendsSql` the DM privacy check uses.
 *    A stranger cannot put anything in your queue at all, which closes most of
 *    the harassment surface before any moderation has to exist.
 *
 * 2. ONLY THE SUBJECT PUBLISHES, and publishing is two deliberate taps over a
 *    preview of exactly what becomes public.
 *
 * 3. REFUSING DELETES THE ROW. This is the "Não aceita!" lesson, and it is
 *    load-bearing rather than tidy. Orkut's pending queue was readable by the
 *    recipient indefinitely, so Brazilians worked out that a depoimento was a
 *    private message and wrote confessions into it prefixed "don't accept
 *    this" — and the canonical folklore is the recipient accepting one anyway.
 *    An approval queue that RETAINS what it refuses is a covert DM channel with
 *    a publish button attached. Two changes answer that: nothing refused is
 *    kept, and the compose sheet offers a real DM as a first-class fork rather
 *    than hoping nobody notices the queue would work.
 *
 * NOTHING HERE IS RICH. Plain text through `safeTextSchema`, no markdown, no
 * links, no images, no HTML — §07's three worms are what the scrap wall's rich
 * content bought Orkut, and there is no version of this feature that needs it.
 */

/**
 * 500 characters.
 *
 * Long enough for the thing people actually write — "conheci essa mulher
 * jogando valorant às 3 da manhã e hoje ela é minha irmã" is 70 — and short
 * enough that a profile card shows a whole depoimento rather than an excerpt
 * with a "more" affordance nobody taps. An essay is a DM.
 */
export const DEPOIMENTO_MAX_LENGTH = 500;

/**
 * Length first, then the control-character refusal. `safeTextSchema` is a
 * `ZodEffects` and has no `.max()`, so the two only compose in this order —
 * the same arrangement `communityTaglineSchema` and `detailsSchema` use.
 */
export const depoimentoBodySchema = z
  .string()
  .trim()
  .min(1, "Write something first.")
  .max(
    DEPOIMENTO_MAX_LENGTH,
    `Keep it to ${DEPOIMENTO_MAX_LENGTH} characters.`,
  )
  .pipe(safeTextSchema);

/**
 * Body of `POST /api/users/:id/depoimentos`.
 *
 * The bound on the raw string is a PAYLOAD GUARD and not the real cap: the
 * generic ZodError handler flattens every schema failure to "Invalid request",
 * and "you are 40 characters over" is a sentence the author has to read in
 * order to fix it. So the route applies `depoimentoBodySchema` itself and
 * returns its message — the same split `updateCommunitySchema` uses.
 */
export const writeDepoimentoSchema = z.object({
  body: z.string().max(4000),
});

export type WriteDepoimentoRequest = z.infer<typeof writeDepoimentoSchema>;

/**
 * One depoimento as anybody may read it.
 *
 * The AUTHOR travels with it and the subject does not: every read is already
 * scoped to one subject (their profile, or your own queue), so repeating them
 * on every row would be noise. `publicUserSchema` and nothing wider — a
 * depoimento is not a place to widen what a profile discloses about the person
 * who wrote it.
 *
 * `approvedAt` is null exactly when the thing is pending, which makes it the
 * one field a client has to look at to know whether it is looking at something
 * private. There is no `status` string to disagree with it.
 */
export const depoimentoSchema = z.object({
  id: z.string().uuid(),
  author: publicUserSchema,
  body: z.string(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
});

export type Depoimento = z.infer<typeof depoimentoSchema>;

/**
 * `GET /api/users/:id/depoimentos` — approved only, newest published first.
 *
 * NO COUNT FIELD, and no count anywhere except the subject's own queue. §05's
 * risk list names the reason: popularity-counting is precisely the dynamic
 * Orkut's "auge ou ostracismo" reputation came from, and a rendered "0
 * depoimentos" is the worst version of it. A client with an empty array hides
 * the section; it never draws a zero.
 */
export const depoimentoListSchema = z.object({
  depoimentos: z.array(depoimentoSchema),
});

export type DepoimentoList = z.infer<typeof depoimentoListSchema>;

/** `GET /api/me/depoimentos/pending` — your queue, oldest-waiting first. */
export const pendingDepoimentoListSchema = z.object({
  depoimentos: z.array(depoimentoSchema),
});

export type PendingDepoimentoList = z.infer<typeof pendingDepoimentoListSchema>;

/**
 * The durable half of the write budget, counted in Postgres so it survives
 * restarts and replicas — the shape `REPORTS_PER_HOUR` established.
 *
 * Ten a day is far above any real use (nobody writes ten testimonials in an
 * afternoon) and far below anything that could be used to paper somebody's
 * queue. It is counted over a window on `created_at` rather than by rows
 * standing, because refusing deletes the row: a cap on standing rows would be
 * reset by the victim declining, which is exactly backwards.
 */
export const DEPOIMENTOS_PER_DAY = 10;

// ------------------------------------------------- community badges on a card

/**
 * A community chip on somebody's profile card: an icon and a name, nothing
 * more.
 *
 * DELIBERATELY NOT `communitySummarySchema`. That carries a tagline, a category
 * and a member count, which is a directory card's worth of information about a
 * room the viewer did not ask about — this is a badge, and a badge that grows a
 * paragraph stops being one. `id` is here so a chip can navigate to the
 * directory entry, and for nothing else.
 *
 * ONLY LISTED COMMUNITIES ARE EVER CHIPPED. A private server is nobody's
 * business but its members'; a community is in a public directory whose card
 * already counts this person. The badge makes an existing public fact legible,
 * which is the whole reason it can be on by default.
 */
export const profileCommunitySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export type ProfileCommunity = z.infer<typeof profileCommunitySchema>;

/**
 * How many chips a card draws before it collapses the rest into "+N".
 *
 * Six is two rows of three at the card's 288px, which is the most that can sit
 * under a name without the identity block stopping being the thing you see
 * first. Orkut's own profile section had no cap and people joined hundreds of
 * communities; the cap is what keeps this a garnish rather than a second list.
 */
export const PROFILE_COMMUNITY_LIMIT = 6;

/**
 * `GET /api/users/:id/communities`.
 *
 * `total` is the number of listed communities this person shows, INCLUDING the
 * ones past the cap, so the client can render "+N" without a second request.
 * It is not a popularity number in the sense the depoimento count would have
 * been: it is bounded by the chips already shown plus a small remainder, and
 * every one of them is individually visible in a public directory.
 */
export const profileCommunityListSchema = z.object({
  communities: z.array(profileCommunitySchema).max(PROFILE_COMMUNITY_LIMIT),
  total: z.number().int().nonnegative(),
});

export type ProfileCommunityList = z.infer<typeof profileCommunityListSchema>;

/**
 * Body of `PATCH /api/servers/:id/profile-visibility` — one membership's
 * opt-out, sent by the member themselves.
 *
 * A separate route from the server PATCH on purpose: that one is the OWNER's
 * (name, retention, SSO domain), and this is a fact about the caller's own
 * membership row that an owner has no business setting. Same reason
 * `updateCommunitySchema` is not folded into `updateServerSchema`.
 */
export const updateProfileVisibilitySchema = z.object({
  showOnProfile: z.boolean(),
});

export type UpdateProfileVisibilityRequest = z.infer<
  typeof updateProfileVisibilitySchema
>;
