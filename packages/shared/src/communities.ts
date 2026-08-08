import { z } from "zod";
import { safeTextSchema } from "./api.js";

/**
 * Communities — the public, joinable half of a server.
 *
 * A community IS a server with three columns set: `is_community`, a tagline and
 * a category. Nothing about channels, messages, roles or invites changes; what
 * changes is that the server appears in a directory anyone signed in can browse
 * and that anyone browsing it can join without an invite.
 *
 * THIS IS A LEGAL CATEGORY CHANGE, NOT A FEATURE FLAG FOR CONVENIENCE.
 * `docs/research/communities-orkut.html` §08 is the argument in full, and the
 * short version is: on 26 June 2025 the STF held Art. 19 of the Marco Civil
 * partially unconstitutional, and the exemption it left standing covers e-mail,
 * private meeting platforms and instant messaging — the bucket pqp sits in
 * today. A public directory of joinable rooms is what moves an instance out of
 * that bucket and into "platform hosting public content", which carries a duty
 * of care, presumed liability for boosted/bot-distributed content, and
 * affirmative duties (a complaint channel, a legal representative, transparency
 * reporting). That is why every route behind this file is gated on
 * `COMMUNITIES_ENABLED`, defaulting off, and why the report path and the
 * operator's suspension switch ship in the same change as the directory itself
 * rather than in a follow-up.
 */

/**
 * The category list, fixed and small.
 *
 * Slugs are stable identifiers stored in the database; the pt-BR labels a
 * Brazilian actually reads live in the client catalogue and may be reworded
 * freely without a migration. Ten of them, chosen for what Brazilians actually
 * gather around rather than for taxonomic completeness — the research doc's
 * point is that the canonical Orkut communities were jokes, so `humor` is a
 * first-class peer of `tech` and not an afterthought.
 *
 * `geral` is last and is the escape hatch. A closed list with no "everything
 * else" member forces every mis-fitting community into whichever slug is
 * nearest, which is how a category filter stops meaning anything.
 *
 * Adding a slug is additive and safe. REMOVING one is not: rows already carry
 * it, and the CHECK constraint in schema.sql is rebuilt on every boot, so a
 * removal would fail the DO block (leaving the old constraint in place) and
 * strand those servers with a category no client can render. Retire a category
 * by hiding its chip in the client, never by deleting it here.
 */
export const COMMUNITY_CATEGORIES = [
  "games",
  "musica",
  "futebol",
  "estudos",
  "anime",
  "tech",
  "humor",
  "series-filmes",
  "corre",
  "geral",
] as const;

export const communityCategorySchema = z.enum(COMMUNITY_CATEGORIES);
export type CommunityCategory = z.infer<typeof communityCategorySchema>;

/**
 * One line. Long enough to carry a joke, short enough that a directory card is
 * a card and not a paragraph — the same 140 the research doc proposed, and the
 * length at which the whole tagline is legible at a glance on a 390px phone.
 */
export const COMMUNITY_TAGLINE_MAX_LENGTH = 140;

/**
 * Length first, then the control-character refinement. `safeTextSchema` is a
 * `ZodEffects` and has no `.max()`, so the two only compose in this order —
 * same arrangement as `detailsSchema` in reports.ts.
 */
export const communityTaglineSchema = z
  .string()
  .trim()
  .max(
    COMMUNITY_TAGLINE_MAX_LENGTH,
    `Keep it to ${COMMUNITY_TAGLINE_MAX_LENGTH} characters.`,
  )
  .pipe(safeTextSchema);

/**
 * The opt-in patch, sent by a server's owner.
 *
 * Absent means "not changing this", which is why every field is optional and
 * why `isCommunity` is a tri-state in practice: absent, true, or false. Turning
 * it off leaves the tagline and category on the row rather than nulling them —
 * an owner who unlists and relists a week later should not have to retype the
 * description, and an unlisted row is invisible to every read path anyway.
 *
 * Deliberately NOT part of `updateServerSchema`. The route that applies it
 * lives behind the flag and has to 404 wholesale when the flag is off; folding
 * these fields into the general server PATCH would mean that route silently
 * accepting and dropping them on a deployment where communities do not exist.
 */
export const updateCommunitySchema = z.object({
  isCommunity: z.boolean().optional(),
  /**
   * Explicit `null` clears the tagline; absent means "not changing". A
   * community may be listed with no tagline — the card falls back to the
   * server name alone, which is exactly how half of Orkut's own directory
   * read.
   *
   * The bound here is a PAYLOAD GUARD, not the real cap: the generic ZodError
   * handler flattens every schema failure to "Invalid request", and "your
   * tagline is 60 characters too long" is a sentence the owner has to read to
   * fix it. So the actual limit is applied by `communityTaglineSchema` in the
   * route, which returns its own message — the same split `ssoEmailDomain`
   * already uses on `updateServerSchema`.
   */
  tagline: z.string().max(4000).nullable().optional(),
  category: communityCategorySchema.optional(),
});
export type UpdateCommunityRequest = z.infer<typeof updateCommunitySchema>;

/**
 * A directory row.
 *
 * Deliberately NOT `serverSchema`. A server shape carries `ownerId`, the
 * retention policy and the SSO domain — three facts about the inside of a
 * server that a stranger browsing a directory has no business reading. This is
 * the public projection, and the same rule `publicUserSchema` states applies:
 * nothing may be added here that is not already something anyone who joined
 * would immediately see.
 */
export const communitySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tagline: z.string().nullable(),
  category: communityCategorySchema,
  /**
   * Read from the maintained counter column, never from a COUNT(*) per row —
   * see `servers.member_count` in schema.sql. Approximate by construction and
   * treated as such: it decorates a card, and nothing is authorised by it.
   */
  memberCount: z.number().int().nonnegative(),
  /** True when the caller is already inside — the card says "Abrir", not "Entrar". */
  joined: z.boolean(),
  createdAt: z.string(),
});
export type CommunitySummary = z.infer<typeof communitySummarySchema>;

export const communityPageSchema = z.object({
  communities: z.array(communitySummarySchema),
  hasMore: z.boolean(),
});
export type CommunityPage = z.infer<typeof communityPageSchema>;

/** What the owner's settings panel reads back for its own server. */
export const communitySettingsSchema = z.object({
  isCommunity: z.boolean(),
  tagline: z.string().nullable(),
  category: communityCategorySchema,
  /**
   * Set by the instance operator, never by the owner, and the reason the panel
   * can say "this is not listed" without lying about why. See
   * `docs/CONTENT_SAFETY.md` — an operator pulls a listing with one UPDATE.
   */
  suspended: z.boolean(),
});
export type CommunitySettings = z.infer<typeof communitySettingsSchema>;

/** Whether this deployment has the directory at all. */
export const communityConfigSchema = z.object({
  enabled: z.boolean(),
});
export type CommunityConfig = z.infer<typeof communityConfigSchema>;

export const COMMUNITY_PAGE_SIZE = 24;
export const COMMUNITY_PAGE_MAX = 48;

/** Same ceiling as `messageSearchQuerySchema`; the directory search is a LIKE. */
export const COMMUNITY_SEARCH_MAX_LENGTH = 100;

export const communitySearchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(COMMUNITY_SEARCH_MAX_LENGTH)
  .pipe(safeTextSchema);

/**
 * The floor a community has to clear to be listed at all.
 *
 * The research doc's cold-start note is the reason: "a directory with 9
 * communities looks worse than no directory". The inverse is just as true —
 * a directory whose first page is forty one-member rooms somebody made to test
 * the button is not a directory either. One live member other than the owner is
 * the cheapest possible signal that a room is real, and it is a floor the owner
 * clears by inviting a single friend, which is a thing they were going to do
 * anyway.
 *
 * A SEARCH IS EXEMPT FROM IT. Somebody typing the exact name of the community
 * their friend just made is not browsing, and answering "no results" for a
 * server that plainly exists is the one behaviour that reads as broken rather
 * than as curation.
 */
export const COMMUNITY_MEMBER_FLOOR = 2;
