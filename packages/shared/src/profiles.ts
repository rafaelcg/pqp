import { z } from "zod";

/**
 * Handles — `pqp.gg/@rafa` — and the thin public profile they address.
 *
 * WHY A NEW COLUMN AND NOT `username`.
 *
 * The product already has `username` and it is already the thing people type at
 * each other. It is not, however, unique: uniqueness lives on the PAIR
 * (`username`, `discriminator`), which is what `idx_users_username_discrim`
 * enforces and what `name#1234` exists to express. Twelve accounts can be
 * `rafa`. So `pqp.gg/rafa` cannot be resolved from `username` alone without
 * inventing a rule for who wins, and every rule available (oldest, most active,
 * lowest number) is a rule somebody loses under and nobody agreed to.
 *
 * A handle is therefore a SECOND, GENUINELY UNIQUE name, claimed first-come and
 * nullable — most accounts will never have one, and nothing in the product
 * depends on having one. `username` keeps doing what it has always done
 * (mentions, the tag, discovery); `handle` does one new thing (a public URL) and
 * is the only name that can, because it is the only one that is unique.
 *
 * WHY LOWERCASE, ASCII AND SHORT. This string is a path segment that travels by
 * screenshot, by WhatsApp, and by being read aloud. `RafaÉ_` and `rafae_` must
 * not be two different people, so the character set is narrowed to what survives
 * that trip: lowercase ASCII, digits, and three separators. Normalisation is
 * lossy on purpose — an uppercase claim becomes its lowercase form rather than
 * being refused, because the person typing `Rafa` meant `rafa` and telling them
 * off for it is friction with no safety behind it.
 */

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;

/**
 * The shape a stored handle must have, and the exact expression the database's
 * CHECK constraint carries. The two are duplicated on purpose, same argument as
 * the community-category CHECK in `schema.sql`: the schema is the last line of
 * defence for a value the API is supposed to have validated, and a constraint
 * that merely says "some text" defends nothing.
 *
 * First and last characters are alphanumeric so a handle can never be `.rafa`,
 * `rafa-` or `--`, all of which read as punctuation rather than as a name and
 * the first of which is a hidden-file convention in half the tools that will
 * ever touch this string.
 */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,18}[a-z0-9]$/;

/** Same expression, as a Postgres regex literal. Keep the two in step. */
export const HANDLE_PATTERN_SQL = "^[a-z0-9][a-z0-9_.-]{1,18}[a-z0-9]$";

/**
 * One rename per 30 days.
 *
 * NOT to punish anybody — it is the anti-squatting rule. Without it, one account
 * can hold every desirable handle in rotation: claim `deus`, screenshot it,
 * rename to `neymar`, screenshot that, rename again. The cooldown makes a
 * handle cost something to move, which is the only thing that makes "first
 * come, first served" mean anything. Thirty days is long enough that churning
 * handles is not a strategy and short enough that a genuine change of name is
 * a wait rather than a wall.
 *
 * The FIRST claim is free — the cooldown only applies to changing a handle you
 * already hold.
 */
export const HANDLE_RENAME_COOLDOWN_DAYS = 30;

/**
 * Names the product needs for itself, plus the ones a stranger holding them
 * would be able to impersonate something with.
 *
 * Three groups, and they are here rather than in a config file because getting
 * one of them wrong is not a configuration mistake, it is a live incident:
 *
 *  1. ROUTES. Every path this SPA serves, and every path it might. `/@app` is
 *     harmless today because handles are `@`-prefixed and routes are not — but
 *     the prefix is a design decision one refactor away from changing, and the
 *     cost of reserving forty words now is nothing.
 *  2. INFRASTRUCTURE. Hostname-shaped words (`www`, `cdn`, `mail`, `ws`) so a
 *     handle can never be confused for a subdomain in a pasted URL.
 *  3. AUTHORITY. `suporte`, `admin`, `oficial`, `moderacao`, `seguranca`,
 *     `pqp` — the words a phisher wants. "pqp.gg/@suporte pediu sua senha" is a
 *     working attack against a Brazilian audience and it costs one free signup.
 *     This is the group worth being generous with.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // routes, present and plausible
  "app",
  "api",
  "about",
  "sobre",
  "ajuda",
  "help",
  "blog",
  "claim",
  "garanta",
  "cookies",
  "docs",
  "doc",
  "download",
  "downloads",
  "faq",
  "home",
  "index",
  "invite",
  "convite",
  "legal",
  "login",
  "entrar",
  "logout",
  "sair",
  "me",
  "meu",
  "privacy",
  "privacidade",
  "settings",
  "config",
  "configuracoes",
  "signin",
  "signup",
  "cadastro",
  "sitemap",
  "status",
  "terms",
  "termos",
  "server",
  "servers",
  "servidor",
  "servidores",
  "channel",
  "canal",
  "dm",
  "chat",
  "voice",
  "voz",
  "search",
  "busca",
  "explore",
  "explorar",
  "comunidade",
  "comunidades",
  "communities",
  "profile",
  "perfil",
  "user",
  "users",
  "usuario",
  "usuarios",
  // infrastructure
  "www",
  "cdn",
  "static",
  "assets",
  "images",
  "img",
  "icons",
  "public",
  "mail",
  "email",
  "smtp",
  "ftp",
  "ws",
  "wss",
  "root",
  "null",
  "undefined",
  "robots",
  "well-known",
  "favicon",
  "manifest",
  "sw",
  // authority and brand
  "pqp",
  "admin",
  "administrador",
  "administrator",
  "suporte",
  "support",
  "sac",
  "staff",
  "equipe",
  "mod",
  "mods",
  "moderator",
  "moderacao",
  "moderador",
  "oficial",
  "official",
  "seguranca",
  "security",
  "sistema",
  "system",
  "billing",
  "pagamento",
  "pix",
  "abuse",
  "denuncia",
  "report",
  "dmca",
  "contato",
  "contact",
  "imprensa",
  "press",
  "jobs",
  "vagas",
  "team",
  "dev",
  "test",
  "teste",
  "demo",
]);

/**
 * Slurs, in a handle, are the one form of abuse this product cannot moderate
 * after the fact — a handle is a URL, so by the time a report arrives the string
 * has already been screenshotted, sent, and indexed. So it is refused at the
 * door.
 *
 * TWO LISTS, and the split is the whole craft of it. A blocklist that is too
 * eager is not a safety feature, it is a support ticket from somebody whose real
 * nickname it refused — and this audience is Brazilian, where `kkk` is laughter
 * and not a klan. So:
 *
 *  - SUBSTRING matched, for terms with essentially no innocent use in Portuguese
 *    or English. `viad0_oficial` is the same attack as `viado`, and padding is
 *    the first thing anybody tries, so these have to match anywhere.
 *  - EXACT matched, for words that are a slur when they ARE the handle and an
 *    ordinary word inside one. `macaco` alone is the racist use; `macacos_fc`
 *    is a supporters' club, and `bichano` is a cat.
 *
 * Every entry in both lists is a slur, not a swear. pqp is not a prudish product
 * — it is named after an expletive — so `porra`, `caralho`, `merda`, `puta` and
 * friends are deliberately ABSENT. What is refused here is hate, not vulgarity.
 *
 * Leetspeak and separators are folded before matching (`foldConfusables`), so
 * `n1gg3r` and `v.i.a.d.o` collapse onto their entries.
 */
const BLOCKED_HANDLE_SUBSTRINGS: readonly string[] = [
  "nigger",
  "nigga",
  "faggot",
  "viado",
  "traveco",
  "sapatao",
  "mongoloide",
  "retardado",
  "nazista",
  "heilhitler",
  "pedofil",
  "pedophil",
  "estupr",
];

/**
 * Only refused when the folded handle IS this word. See the note above on why
 * these cannot be substrings.
 */
const BLOCKED_HANDLE_EXACT: ReadonlySet<string> = new Set([
  "macaco",
  "macacos",
  "crioulo",
  "negrinho",
  "bicha",
  "nazi",
  "hitler",
  "retard",
  "rape",
]);

/**
 * Leet and separator folding, for blocklist matching ONLY.
 *
 * Never used for storage or comparison of real handles: `r4fa` and `rafa` are
 * two different people and must stay two different rows. It exists so that
 * padding a slur with digits and dots does not walk it past the list above.
 */
function foldConfusables(handle: string): string {
  return handle
    .replace(/[._-]/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s");
}

/**
 * What somebody typed, as the handle it would become.
 *
 * Strips a leading `@` (people type the thing they saw on the page), lowercases,
 * folds the Portuguese accents a Brazilian keyboard produces by reflex
 * (`joão` → `joao`), and turns whitespace into `_`. Everything the character
 * set cannot hold is dropped rather than rejected — this runs on every keystroke
 * of the claim field, and a form that erases what you typed because you reached
 * for `ç` is a form people leave.
 *
 * Idempotent: `normalizeHandle(normalizeHandle(x)) === normalizeHandle(x)`.
 */
export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .normalize("NFD")
    // Combining marks — this is what turns `ã` into `a` once NFD has split it.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, HANDLE_MAX_LENGTH);
}

/**
 * Why a handle cannot be claimed, or null when it can.
 *
 * A discriminated reason rather than a message, because the client renders it in
 * two languages and the server renders it in neither — it answers HTTP status
 * codes. One enum, three consumers, no drift.
 *
 * `taken` is deliberately NOT here: it is not a property of the string, it is a
 * property of the database at one instant, and only the unique index can say it.
 */
export type HandleRejection = "length" | "format" | "reserved" | "blocked";

export function validateHandle(candidate: string): HandleRejection | null {
  if (
    candidate.length < HANDLE_MIN_LENGTH ||
    candidate.length > HANDLE_MAX_LENGTH
  ) {
    return "length";
  }
  if (!HANDLE_PATTERN.test(candidate)) {
    return "format";
  }
  if (RESERVED_HANDLES.has(candidate)) {
    return "reserved";
  }
  const folded = foldConfusables(candidate);
  if (BLOCKED_HANDLE_SUBSTRINGS.some((term) => folded.includes(term))) {
    return "blocked";
  }
  if (BLOCKED_HANDLE_EXACT.has(folded)) {
    return "blocked";
  }
  return null;
}

/** Convenience for call sites that only ask yes or no. */
export function isValidHandle(candidate: string): boolean {
  return validateHandle(candidate) === null;
}

/**
 * Zod-shaped handle, for request bodies. Normalises first so a body carrying
 * `@Rafa` is accepted as `rafa` rather than refused — the wire is not the place
 * to teach clients about our character set.
 */
export const handleSchema = z
  .string()
  .max(64)
  .transform(normalizeHandle)
  .refine(isValidHandle, "That handle cannot be used");

export const claimHandleSchema = z.object({ handle: handleSchema });

export type ClaimHandleRequest = z.infer<typeof claimHandleSchema>;

/**
 * When the account may next change its handle. Null means "now" — either it has
 * never claimed one, or the cooldown has already run out.
 */
export function handleRenameAvailableAt(
  handleChangedAt: string | Date | null | undefined,
  currentHandle: string | null | undefined,
): Date | null {
  if (!currentHandle || !handleChangedAt) {
    return null;
  }
  const changed = new Date(handleChangedAt);
  if (Number.isNaN(changed.getTime())) {
    return null;
  }
  const available = new Date(
    changed.getTime() + HANDLE_RENAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  );
  return available;
}

export function canRenameHandle(
  handleChangedAt: string | Date | null | undefined,
  currentHandle: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const available = handleRenameAvailableAt(handleChangedAt, currentHandle);
  return available === null || available.getTime() <= now.getTime();
}

/**
 * One community, as a badge on a public profile.
 *
 * The Orkut throwback, and the only thing on the page that is not the person
 * themselves. Deliberately just a name and a category: no member count, no
 * join link, no description. A badge says "this person is in this room"; a
 * directory entry is a different feature and it lives behind
 * `COMMUNITIES_ENABLED`.
 */
export const profileBadgeSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: z.string(),
});

export type ProfileBadge = z.infer<typeof profileBadgeSchema>;

/**
 * A public profile, and the whole of it.
 *
 * WHAT IS NOT HERE IS THE FEATURE. No id, no email, no tag (`name#1234` is the
 * thing you need to add somebody, and handing it to an unauthenticated crawler
 * would turn every profile page into a contact-details dump), no presence, no
 * messages, no server list beyond public communities, no join date. This is
 * served to anybody on the internet with no token at all, so every field here
 * had to argue its way in, and the argument was "a screenshot of this page is
 * the product's advertisement".
 *
 * `depoimentoCount` is a NUMBER and never the depoimentos themselves — the count
 * is social proof, the contents are user-generated text about a third party and
 * belong behind a login.
 */
export const publicProfileSchema = z.object({
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  badges: z.array(profileBadgeSchema),
  depoimentoCount: z.number().int().nonnegative(),
});

export type PublicProfile = z.infer<typeof publicProfileSchema>;

/** The path a handle lives at. One definition, so the `@` cannot drift. */
export function publicProfilePath(handle: string): string {
  return `/@${handle}`;
}

export const PQP_SITE_ORIGIN = "https://pqp.gg";

/** The URL people paste into their bio. Shown with the scheme stripped. */
export function publicProfileUrl(
  handle: string,
  origin: string = PQP_SITE_ORIGIN,
): string {
  return `${origin}${publicProfilePath(handle)}`;
}

/** `pqp.gg/@rafa` — the display form, which is what fits on a button. */
export function publicProfileDisplayUrl(handle: string): string {
  return `pqp.gg${publicProfilePath(handle)}`;
}

/**
 * Pull a handle out of a pathname, or null.
 *
 * SHAPE ONLY — deliberately not `validateHandle`. This answers "is this URL a
 * profile URL", which is a different question from "may this handle be
 * claimed": a reserved word has no profile and the API answers 404 for it like
 * any other unclaimed name, so applying the claim-time rules here would only
 * make two paths that behave identically look different.
 *
 * It also does NOT normalise beyond lowercasing. `normalizeHandle` is lossy by
 * design — it truncates and strips — and lossy is exactly wrong for resolving an
 * address: a 40-character path segment must be "no such profile", never a
 * silent redirect to the first twenty characters of somebody else's name.
 *
 * The Pages middleware carries its own copy of this (it must not import the
 * workspace package — see `client/src/lib/profile-meta.ts`), and
 * `profile-meta.test.ts` asserts the two agree on every path either can see.
 */
export function handleFromPath(pathname: string): string | null {
  const match = /^\/@([^/?#]+)\/?$/.exec(pathname);
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
  return HANDLE_PATTERN.test(candidate) ? candidate : null;
}
