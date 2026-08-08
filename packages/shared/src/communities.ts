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
 * The language a community is held in — a second, orthogonal axis to category.
 *
 * WHY IT IS NOT A CATEGORY. "English-speaking" is not a subject, and modelling
 * it as one would force every English room to give up its real shelf: an
 * English football server belongs under `futebol` next to the Portuguese ones,
 * because somebody browsing football wants to see it. Language is what they
 * filter by *afterwards*, when what they need is a room they can actually talk
 * in. Two axes, one filter each.
 *
 * TWO VALUES, AND DELIBERATELY NOT A BCP-47 TAG. `pt-BR` versus `pt-PT` is a
 * distinction no member of this directory needs to make — they are the same
 * room to a person looking for one — and a free-text locale column is a column
 * that accumulates `PT`, `pt_br`, `português` and `en-US` until the filter
 * matches nothing. Adding a third language is additive and safe; removing one
 * has the same problem `COMMUNITY_CATEGORIES` documents, for the same reason
 * (rows carry it, and schema.sql rebuilds the CHECK on every boot).
 *
 * `pt` is the default everywhere — in the column, in the PATCH, and in the
 * seeder — because this is a Brazilian instance and the overwhelming majority
 * of rooms will never think about this field at all.
 */
export const COMMUNITY_LANGUAGES = ["pt", "en"] as const;

export const communityLanguageSchema = z.enum(COMMUNITY_LANGUAGES);
export type CommunityLanguage = z.infer<typeof communityLanguageSchema>;

/** What a listing gets when nobody says otherwise. */
export const DEFAULT_COMMUNITY_LANGUAGE: CommunityLanguage = "pt";

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

// ------------------------------------------------------------------- slugs

/**
 * `pqp.gg/c/valorant-brasil` — a community's public address.
 *
 * WHY NOT THE ID. The directory already addresses a community by uuid, and a
 * uuid is exactly the right identifier for a thing the API talks about and
 * exactly the wrong one for a thing a person says out loud. The brief for this
 * surface was "for discover to be easy", and nothing about
 * `/c/3f2a1c9e-…-b41d` is easy: it cannot be typed, cannot be read over a call,
 * cannot be guessed at from the name on a poster, and tells a stranger nothing
 * about where the link goes before they click it.
 *
 * WHY A SEPARATE NAMESPACE FROM HANDLES. `/@rafa` and `/c/valorant` never
 * collide, which is what lets a community and a person hold the same word. The
 * alternative — one flat namespace — means the day somebody's community is
 * called `rafa` one of the two loses a URL that is already in screenshots.
 *
 * The character set is narrower than a handle's: no `.` and no `_`. A handle is
 * chosen by one person for themselves and reads as a username; a community slug
 * is derived from a NAME by a machine (`slugifyCommunityName`), and hyphens are
 * the only separator a derivation can produce without inventing punctuation
 * nobody wrote. It is also longer — forty rather than twenty — because "the
 * name, hyphenated" is a phrase and not a nickname.
 */
export const COMMUNITY_SLUG_MIN_LENGTH = 3;
export const COMMUNITY_SLUG_MAX_LENGTH = 40;

/**
 * The shape a stored slug must have, and the exact expression the database's
 * CHECK constraint carries. Duplicated on purpose, same argument the handle
 * pattern makes: the schema is the last line of defence for a value the API is
 * supposed to have validated, and a constraint that says "some text" defends
 * nothing.
 *
 * First and last characters are alphanumeric, so a slug can never be `-x`,
 * `x-`, or `--` — all of which read as punctuation rather than as a name.
 */
export const COMMUNITY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Same expression, as a Postgres regex literal. Keep the two in step. */
export const COMMUNITY_SLUG_PATTERN_SQL = "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$";

/**
 * Words the slug namespace needs for itself.
 *
 * Much shorter than `RESERVED_HANDLES`, and that asymmetry is correct rather
 * than an oversight: handles live at the site root, where they compete with
 * every route the product will ever add, while a slug lives under `/c/` where
 * the only thing it can collide with is another slug. What is left is the
 * authority group — the words a phisher wants — plus the two paths a `/c/`
 * subtree might plausibly grow.
 */
export const RESERVED_COMMUNITY_SLUGS: ReadonlySet<string> = new Set([
  "new",
  "nova",
  "novo",
  "all",
  "todas",
  "todos",
  "search",
  "busca",
  "explore",
  "explorar",
  "admin",
  "staff",
  "equipe",
  "moderacao",
  "suporte",
  "support",
  "oficial",
  "official",
  "pqp",
  "api",
  "app",
  "www",
  "null",
  "undefined",
]);

/**
 * A community's name, as the slug it would become.
 *
 * `Valorant Brasil 🇧🇷` → `valorant-brasil`. Accents are folded the way
 * `normalizeHandle` folds them (a Brazilian keyboard produces `ã` by reflex and
 * `joão` and `joao` must not be two different pages), everything outside the
 * character set collapses to a single hyphen, and the ends are trimmed.
 *
 * LOSSY, AND THE LOSS IS THE POINT for a derivation: a name of pure emoji
 * yields the empty string, which the caller has to treat as "this cannot be
 * derived, ask the owner" rather than as a slug. `deriveCommunitySlug` below is
 * the function that makes that distinction; this one only transliterates.
 *
 * Idempotent: `slugifyCommunityName(slugifyCommunityName(x))` is
 * `slugifyCommunityName(x)`.
 */
export function slugifyCommunityName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    // Combining marks — what turns `ã` into `a` once NFD has split it.
    .replace(/[\u0300-\u036f]/g, "")
    // `ß`, `æ` and friends survive NFD intact; they are not in the set, so they
    // fall to the separator rule below along with spaces and punctuation.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, COMMUNITY_SLUG_MAX_LENGTH)
    // The slice can leave a trailing hyphen the pattern refuses.
    .replace(/-+$/g, "");
}

/**
 * Why a slug cannot be used, or null when it can.
 *
 * A discriminated reason rather than a message — one enum, three consumers, no
 * drift — exactly as `HandleRejection` is. `taken` is deliberately not here for
 * the same reason it is not there: it is a property of the database at one
 * instant, and only the unique index can say it.
 */
export type CommunitySlugRejection = "length" | "format" | "reserved";

export function validateCommunitySlug(
  candidate: string,
): CommunitySlugRejection | null {
  if (
    candidate.length < COMMUNITY_SLUG_MIN_LENGTH ||
    candidate.length > COMMUNITY_SLUG_MAX_LENGTH
  ) {
    return "length";
  }
  if (!COMMUNITY_SLUG_PATTERN.test(candidate)) {
    return "format";
  }
  if (RESERVED_COMMUNITY_SLUGS.has(candidate)) {
    return "reserved";
  }
  return null;
}

export function isValidCommunitySlug(candidate: string): boolean {
  return validateCommunitySlug(candidate) === null;
}

/**
 * The slug a community would get from its name on opt-in, or null when the name
 * cannot produce one.
 *
 * NULL IS A REAL ANSWER AND THE CALLER MUST HANDLE IT. `🔥🔥🔥` slugifies to
 * nothing and `ok` is two characters; neither is a failure of the name — plenty
 * of good communities are called that — so the route answers with a field to
 * type one in rather than refusing the listing. Same shape as a collision.
 */
export function deriveCommunitySlug(name: string): string | null {
  const slug = slugifyCommunityName(name);
  return isValidCommunitySlug(slug) ? slug : null;
}

/**
 * Zod-shaped slug, for request bodies. Slugifies first so a body carrying
 * `Valorant Brasil` is accepted as `valorant-brasil` rather than refused — the
 * wire is not the place to teach clients about our character set. Same
 * arrangement `handleSchema` uses.
 */
export const communitySlugSchema = z
  .string()
  .max(120)
  .transform(slugifyCommunityName)
  .refine(isValidCommunitySlug, "That address cannot be used");

/** The path a community's public page lives at. One definition, one prefix. */
export function publicCommunityPath(slug: string): string {
  return `/c/${slug}`;
}

/** The URL people paste into a group chat. Shown with the scheme stripped. */
export function publicCommunityUrl(
  slug: string,
  origin: string = "https://pqp.gg",
): string {
  return `${origin}${publicCommunityPath(slug)}`;
}

/** `pqp.gg/c/valorant-brasil` — the display form, which is what fits a button. */
export function publicCommunityDisplayUrl(slug: string): string {
  return `pqp.gg${publicCommunityPath(slug)}`;
}

/**
 * Pull a slug out of a pathname, or null.
 *
 * SHAPE ONLY, deliberately not `validateCommunitySlug` — the same distinction
 * `handleFromPath` draws. This answers "is this URL a community URL", which is
 * a different question from "may this slug be claimed": a reserved word names
 * no community and the API answers 404 for it like any other unknown slug, so
 * applying the claim-time rules here would only make two paths that behave
 * identically look different.
 *
 * It also does not normalise beyond lowercasing. Slugification is lossy — it
 * truncates and strips — and lossy is exactly wrong for resolving an address: a
 * 200-character path segment must be "no such community", never a silent
 * redirect to the first forty characters of somebody else's page.
 *
 * The Pages middleware carries its own copy of this (it must not import the
 * workspace package — see `client/src/lib/community-meta.ts`), and
 * `community-meta.test.ts` asserts the two agree on every path either can see.
 */
export function communitySlugFromPath(pathname: string): string | null {
  const match = /^\/c\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const candidate = decoded.toLowerCase();
  return COMMUNITY_SLUG_PATTERN.test(candidate) ? candidate : null;
}

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
  /**
   * The public address, when the owner is choosing one rather than taking the
   * derived default.
   *
   * ABSENT IS THE COMMON CASE and it means "leave it alone" — including on the
   * very first opt-in, where the server derives one from the name. This field
   * exists for the two cases a derivation cannot serve: a collision (somebody
   * already holds `valorant`), and a name that slugifies to nothing. Both come
   * back as a refusal naming this field, which is what turns "we could not list
   * you" into "pick another address".
   *
   * The bound is a payload guard, not the real cap: `communitySlugSchema` in
   * the route applies the length and character rules and returns its own
   * message, the same split the tagline uses.
   */
  slug: z.string().max(120).optional(),
  /**
   * Absent means "not changing this", like every other field here — NOT "reset
   * to pt". The default belongs to the column, so a PATCH that only edits a
   * tagline cannot silently move an English room back into the Portuguese
   * filter.
   */
  language: communityLanguageSchema.optional(),
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
  /**
   * The public address, or null on a community listed before slugs existed and
   * not yet backfilled. Defaulted rather than required so an older API's
   * payload still parses — the card hides its share button when it is null.
   */
  slug: z.string().nullable().default(null),
  tagline: z.string().nullable(),
  category: communityCategorySchema,
  /**
   * Which language the room is held in. Public for the same reason the category
   * is: it is the second thing somebody filters a directory by, and knowing it
   * before you walk in is the difference between joining a room and leaving it.
   *
   * Defaulted rather than required so a client built against an older server —
   * or a fixture written before this column existed — parses instead of
   * throwing on every card.
   */
  language: communityLanguageSchema.default(DEFAULT_COMMUNITY_LANGUAGE),
  /**
   * Read from the maintained counter column, never from a COUNT(*) per row —
   * see `servers.member_count` in schema.sql. Approximate by construction and
   * treated as such: it decorates a card, and nothing is authorised by it.
   */
  memberCount: z.number().int().nonnegative(),
  /** True when the caller is already inside — the card says "Abrir", not "Entrar". */
  joined: z.boolean(),
  createdAt: z.string(),
  /**
   * The server's own icon and banner, or null where it set none.
   *
   * Public by construction: a community has asked to be found, and its picture
   * is the first thing a directory card is for. Nothing else about the server
   * is widened by carrying them — both are already visible to anyone who walks
   * in through the card, which is what the card exists to let them do.
   */
  iconUrl: z.string().nullable().default(null),
  bannerUrl: z.string().nullable().default(null),
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
  /** Null until the first successful opt-in derives or the owner picks one. */
  slug: z.string().nullable().default(null),
  tagline: z.string().nullable(),
  category: communityCategorySchema,
  language: communityLanguageSchema.default(DEFAULT_COMMUNITY_LANGUAGE),
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

// -------------------------------------------------- the public `/c/…` page

/**
 * One community, for anybody on the internet with no account.
 *
 * THE SECOND UNAUTHENTICATED READ IN THE PRODUCT THAT ANSWERS WITH CONTENT,
 * and it is held to `publicProfileSchema`'s bar: every field had to argue its
 * way in, and the argument is "a stranger deciding whether to sign up needs
 * this to decide". What that admits is the poster — name, address, tagline,
 * category, how many people are in there, the two pictures. What it refuses is
 * everything a member can see and a stranger cannot: NO MEMBER LIST (which is a
 * disclosure of who talks to whom, the single worst thing this page could do),
 * NO MESSAGES, no channel list, no owner, no id.
 *
 * NO `joined` FIELD, unlike `communitySummarySchema`. There is no viewer to be
 * joined — the whole point of this shape is that it is identical for every
 * caller, which is also what makes it cacheable at the edge for a minute the
 * way the public profile is.
 *
 * THE ID IS ABSENT ON PURPOSE and the omission has teeth: the join CTA carries
 * the SLUG through sign-up (`?join=<slug>`) and the app resolves it behind
 * auth. A stranger never learns an id they could feed to another endpoint, and
 * the one endpoint that would take it is behind the same flag and the same
 * gate as everything else in this feature.
 */
export const publicCommunitySchema = z.object({
  slug: z.string(),
  name: z.string(),
  tagline: z.string().nullable(),
  category: communityCategorySchema,
  /** From the maintained counter column. Approximate, and nothing is authorised by it. */
  memberCount: z.number().int().nonnegative(),
  iconUrl: z.string().nullable().default(null),
  bannerUrl: z.string().nullable().default(null),
  /** `YYYY-MM`. Month granularity, same rule the public profile follows. */
  createdMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().default(null),
});

export type PublicCommunity = z.infer<typeof publicCommunitySchema>;

/**
 * `?join=<slug>` on any `/app` URL.
 *
 * The public community page's CTA sends people to `/app?join=<slug>` when they
 * are already signed in, and stashes the same slug before Clerk takes over when
 * they are not — the arrangement `?add=<handle>` already uses, for the identical
 * reason: a modal is a navigation this component does not survive. Only the
 * shape is checked here; whether the community exists is the API's answer.
 */
export function joinIntentFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("join");
  if (!raw) {
    return null;
  }
  const slug = raw.toLowerCase();
  return COMMUNITY_SLUG_PATTERN.test(slug) ? slug : null;
}
