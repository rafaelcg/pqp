import { z } from "zod";
import { TIMEOUT_MAX_MINUTES } from "./sanctions.js";

/**
 * AutoMod: the rules a server enforces on a message before it lands.
 *
 * Shape follows Discord's AutoMod, because that is what moderators arrive
 * knowing: a rule is a trigger, an action, and its exemptions. Three triggers
 * ship in this first wave, the three a small hall actually turns on:
 *
 * - `keywords`: the owner's blocked words. `*` is the only wildcard, and it
 *   works the way Discord's does: `scam*` matches `scammer`, `*hole` matches
 *   `loophole`, `*cat*` matches anywhere, and no wildcard means a whole word
 *   or phrase. Case-insensitive, unicode-aware, and normalised first (see
 *   `normalizeForAutomod`) so `sc<zero-width>am` and fullwidth letters do not walk
 *   past it. Every rule has an allow list that wins over a hit.
 * - `invite_links`: a Discord invite in the body. Opt-in. With
 *   `blockPqpInvites` it also catches a link to *another* pqp server (an
 *   `/app/invite/<code>` or a `pqp.gg/c/<slug>`); links to the server the
 *   message is in are let through, which is the caller's call to make
 *   (`AutomodContext.ownPqpInvite`), because only the server knows its codes.
 * - `mention_spam`: more than N distinct mentions in one message. Opt-in.
 *
 * The first action is always block-and-tell: the message never lands and the
 * author gets `message-rejected` with `reason: "automod"` plus the rule's own
 * `customMessage`. Two more may be added per rule, the same two Discord
 * offers: post an alert into a channel the moderators read, and time the
 * author out. Regex triggers are deliberately not here; see the issue.
 *
 * This module is pure so the server enforces it and the client's settings
 * page can run the same code as a "test a message" preview. The two must
 * never disagree about what a rule catches.
 */

export const AUTOMOD_RULE_KINDS = [
  "keywords",
  "invite_links",
  "mention_spam",
] as const;
export const automodRuleKindSchema = z.enum(AUTOMOD_RULE_KINDS);
export type AutomodRuleKind = z.infer<typeof automodRuleKindSchema>;

/** Discord's limits, kept so a migrated list fits without trimming. */
export const AUTOMOD_KEYWORDS_MAX = 1000;
export const AUTOMOD_KEYWORD_LENGTH_MAX = 60;
export const AUTOMOD_ALLOW_LIST_MAX = 100;
export const AUTOMOD_MENTION_LIMIT_MIN = 1;
export const AUTOMOD_MENTION_LIMIT_MAX = 50;
export const AUTOMOD_MENTION_LIMIT_DEFAULT = 5;
export const AUTOMOD_CUSTOM_MESSAGE_MAX = 150;
export const AUTOMOD_EXEMPT_ROLES_MAX = 20;
export const AUTOMOD_EXEMPT_CHANNELS_MAX = 50;
/**
 * Timeout-on-trip choices, in minutes. 0 is off. The rest are Discord's
 * ladder (60 s, 5 min, 10 min, 1 h, 1 d, 1 w), so a moderator arriving from
 * there finds the number they already use.
 */
export const AUTOMOD_TIMEOUT_PRESET_MINUTES = [0, 1, 5, 10, 60, 1440, 10080] as const;
export const AUTOMOD_TIMEOUT_MAX_MINUTES = TIMEOUT_MAX_MINUTES;

/** One keyword or allow-list entry: trimmed, non-empty, no newlines. */
export const automodKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(AUTOMOD_KEYWORD_LENGTH_MAX)
  .refine((value) => !/[\r\n]/.test(value), "no line breaks");

export const automodRuleSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  kind: automodRuleKindSchema,
  enabled: z.boolean(),
  keywords: z.array(automodKeywordSchema).max(AUTOMOD_KEYWORDS_MAX),
  allowList: z.array(automodKeywordSchema).max(AUTOMOD_ALLOW_LIST_MAX),
  mentionLimit: z
    .number()
    .int()
    .min(AUTOMOD_MENTION_LIMIT_MIN)
    .max(AUTOMOD_MENTION_LIMIT_MAX),
  exemptRoleIds: z.array(z.string().uuid()).max(AUTOMOD_EXEMPT_ROLES_MAX),
  exemptChannelIds: z
    .array(z.string().uuid())
    .max(AUTOMOD_EXEMPT_CHANNELS_MAX),
  /** Shown to the author under the composer. Empty means the default copy. */
  customMessage: z.string().trim().max(AUTOMOD_CUSTOM_MESSAGE_MAX),
  /** A text channel in the same server that gets a post per hit. Null: none. */
  alertChannelId: z.string().uuid().nullable(),
  /** Time the author out for this long on a hit. 0: do not. */
  timeoutMinutes: z.number().int().min(0).max(AUTOMOD_TIMEOUT_MAX_MINUTES),
  /**
   * `invite_links` only: also block links to other pqp servers. Discord
   * links are always part of that rule; this is the second half.
   */
  blockPqpInvites: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AutomodRule = z.infer<typeof automodRuleSchema>;

/** Body of `POST /api/servers/:serverId/automod/rules`. */
export const createAutomodRuleSchema = automodRuleSchema
  .pick({
    kind: true,
    keywords: true,
    allowList: true,
    mentionLimit: true,
    exemptRoleIds: true,
    exemptChannelIds: true,
    customMessage: true,
    alertChannelId: true,
    timeoutMinutes: true,
    blockPqpInvites: true,
  })
  .partial()
  .required({ kind: true })
  .extend({ enabled: z.boolean().optional() });
export type CreateAutomodRuleInput = z.infer<typeof createAutomodRuleSchema>;

/** Body of `PATCH /api/servers/:serverId/automod/rules/:ruleId`. `kind` is fixed. */
export const updateAutomodRuleSchema = createAutomodRuleSchema
  .omit({ kind: true })
  .refine((patch) => Object.keys(patch).length > 0, "nothing to change");
export type UpdateAutomodRuleInput = z.infer<typeof updateAutomodRuleSchema>;

/**
 * The part of a rule the matcher needs. The server hands it rows, the
 * settings preview hands it the unsaved form.
 */
export type AutomodRuleInput = Pick<
  AutomodRule,
  "kind" | "keywords" | "allowList" | "mentionLimit"
> & {
  id?: string;
  customMessage?: string;
  enabled?: boolean;
  blockPqpInvites?: boolean;
};

/**
 * What the matcher cannot know on its own. `ownPqpInvite` says whether a pqp
 * link found in the body points at the server the message is in: the server
 * answers from its invite codes and community slug, the settings preview
 * from the slug alone. Absent, every pqp link counts as another server's.
 */
export interface AutomodContext {
  ownPqpInvite?: (link: PqpInviteLink) => boolean;
}

export interface AutomodVerdict {
  kind: AutomodRuleKind;
  ruleId?: string;
  /** The word, link or count that tripped the rule, for the audit row. */
  matched: string;
  customMessage?: string;
}

/**
 * Which rule kind a verdict names, as copy the alert and the audit reason can
 * print. PT-BR, the same words the settings UI uses: the alert is a stored
 * message, so the server picks one language and the product's is Portuguese.
 */
export const AUTOMOD_KIND_LABEL: Record<AutomodRuleKind, string> = {
  keywords: "Palavras bloqueadas",
  invite_links: "Convites de outros servidores",
  mention_spam: "Spam de menção",
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Characters that are invisible in a bubble and only ever appear inside a
 * word to split it: zero-width space, joiner, non-joiner, word joiner, BOM,
 * (the combining grapheme joiner is a mark and goes with `COMBINING_RE`),
 * soft hyphen, and the invisible operators.
 */
const INVISIBLE_RE =
  /[\u00AD\u061C\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** Combining marks: `s̶c̶a̶m̶` and `ẹ́` both become their base letters. */
const COMBINING_RE = /\p{M}+/gu;

/**
 * Homoglyphs a keyboard switch or a paste can produce. Only the letters whose
 * lookalike is near-universal are here; this is not a confusables table. The
 * map runs after NFKC, which already folds fullwidth, circled and mathematical
 * letters onto ASCII.
 */
const CONFUSABLES: Record<string, string> = {
  "а": "a", // Cyrillic а
  "е": "e", // Cyrillic е
  "о": "o", // Cyrillic о
  "р": "p", // Cyrillic р
  "с": "c", // Cyrillic с
  "х": "x", // Cyrillic х
  "у": "y", // Cyrillic у
  "і": "i", // Cyrillic і
  "ј": "j", // Cyrillic ј
  "һ": "h", // Cyrillic һ
  "α": "a", // Greek α
  "ο": "o", // Greek ο
  "ρ": "p", // Greek ρ
  "ν": "v", // Greek ν
  "ι": "i", // Greek ι
  "ı": "i", // dotless i
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
};
const CONFUSABLE_RE = new RegExp(
  `[${Object.keys(CONFUSABLES).join("")}]`,
  "g",
);

/**
 * Fold a body (or a keyword) to the form the matcher compares.
 *
 * Order matters: NFKC first so compatibility characters become their ASCII
 * base, then NFD so every accent is a separate combining mark, strip those
 * marks, drop the invisibles, lowercase, map the handful of homoglyphs, and
 * collapse whitespace. Accents are stripped on purpose: the alternative is a
 * blocked word that `é` walks past, and a Brazilian hall's blocked list is
 * mostly words people type both ways.
 */
export function normalizeForAutomod(text: string): string {
  return text
    .normalize("NFKC")
    .normalize("NFD")
    .replace(COMBINING_RE, "")
    .replace(INVISIBLE_RE, "")
    // Lowercase before the homoglyph map: the map lists lowercase letters,
    // and an uppercase Cyrillic А would otherwise survive as-is.
    .toLowerCase()
    .replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] ?? ch)
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * The matcher is a token scan, not a regular expression built from the
 * owner's list. The first version compiled every keyword into one big
 * alternation with unbounded `[\p{L}\p{N}_]*` runs for the wildcards, and a
 * review measured a single hostile keyword (`a*a*a*...*b`) stalling the API
 * process for 46 seconds on a 40-character word. Owner input must never
 * become a pattern. Everything below is `startsWith`, `endsWith`, `indexOf`
 * and equality over words, so the cost is linear in body length times list
 * length, whatever the list says.
 */

/** A body split into words, each with its span in the normalised text. */
interface Token {
  text: string;
  start: number;
  end: number;
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const isWord = i < text.length && WORD_CHAR_RE.test(text[i]!);
    if (isWord && start < 0) {
      start = i;
    } else if (!isWord && start >= 0) {
      tokens.push({ text: text.slice(start, i), start, end: i });
      start = -1;
    }
  }
  return tokens;
}

/**
 * One keyword, parsed. `leading` and `trailing` are the edge wildcards;
 * `words` is the phrase split on whitespace, each word split again on any
 * interior `*` into literal parts (`s*m` is `["s", "m"]`).
 */
export interface ParsedKeyword {
  source: string;
  leading: boolean;
  trailing: boolean;
  words: string[][];
}

/**
 * Parse one keyword. Exported for tests. Returns null for an entry that is
 * only wildcards or punctuation, which would otherwise match every message.
 *
 * `*` at either end removes that edge's word boundary; `*` inside a word
 * matches any run of word characters within that same word. Spaces in a
 * phrase match any run of non-word characters. Everything else is literal.
 */
export function parseKeyword(keyword: string): ParsedKeyword | null {
  const normalized = normalizeForAutomod(keyword);
  const leading = normalized.startsWith("*");
  const trailing = normalized.endsWith("*") && normalized.length > 1;
  const core = normalized.replace(/^\*+/, "").replace(/\*+$/, "");
  if (!core || !/[\p{L}\p{N}]/u.test(core)) {
    return null;
  }
  // Punctuation inside a keyword is dropped the way `tokenize` drops it from
  // a body, so `a.b` matches the body `a.b` (tokens `a`, `b`) and `(lol)`
  // matches `(lol)`.
  const words = core
    .split(/[^\p{L}\p{N}_*]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.split(/\*+/).filter((part) => part.length > 0));
  if (words.length === 0 || words.some((parts) => parts.length === 0)) {
    return null;
  }
  return { source: keyword, leading, trailing, words };
}

/**
 * Does `token` match a word made of literal `parts` with wildcard runs
 * between them? `open` at either end means that edge is unanchored.
 * Greedy leftmost placement of every part but the last is enough to decide
 * existence, and it is linear in the token's length.
 */
function matchParts(
  token: string,
  parts: string[],
  openStart: boolean,
  openEnd: boolean,
): boolean {
  if (token.length === 0) {
    return false;
  }
  if (parts.length === 1) {
    const [part] = parts as [string];
    if (!openStart && !openEnd) return token === part;
    if (!openStart) return token.startsWith(part);
    if (!openEnd) return token.endsWith(part);
    return token.includes(part);
  }
  const first = parts[0]!;
  let pos: number;
  if (openStart) {
    pos = token.indexOf(first);
    if (pos < 0) return false;
    pos += first.length;
  } else {
    if (!token.startsWith(first)) return false;
    pos = first.length;
  }
  for (let i = 1; i < parts.length - 1; i++) {
    const found = token.indexOf(parts[i]!, pos);
    if (found < 0) return false;
    pos = found + parts[i]!.length;
  }
  const last = parts[parts.length - 1]!;
  if (openEnd) {
    return token.indexOf(last, pos) >= 0;
  }
  return token.endsWith(last) && token.length - last.length >= pos;
}

/**
 * Every span of `tokens` that `keyword` matches, as [first token index, last
 * token index]. A single-word keyword is tested against each token; a phrase
 * is a sliding window where only the first and last words honour the edge
 * wildcards.
 */
function matchSpans(tokens: Token[], keyword: ParsedKeyword): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = keyword.words.length;
  for (let i = 0; i + n <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < n && ok; j++) {
      const openStart = j === 0 && keyword.leading;
      const openEnd = j === n - 1 && keyword.trailing;
      ok = matchParts(tokens[i + j]!.text, keyword.words[j]!, openStart, openEnd);
    }
    if (ok) {
      spans.push([i, i + n - 1]);
    }
  }
  return spans;
}

export interface CompiledKeywords {
  /** Exact single words, for an O(1) lookup per token. */
  exact: Set<string>;
  /** Everything else: wildcards and phrases. */
  scan: ParsedKeyword[];
  allow: ParsedKeyword[];
  /** True when no entry survived parsing: nothing to match. */
  isEmpty: boolean;
}

/**
 * Parse a keyword list once per rule. Exact single words go in a set so a
 * thousand of them cost one lookup per token; only wildcards and phrases
 * are scanned.
 */
export function compileKeywords(
  keywords: readonly string[],
  allowList: readonly string[] = [],
): CompiledKeywords {
  const exact = new Set<string>();
  const scan: ParsedKeyword[] = [];
  for (const raw of keywords) {
    const parsed = parseKeyword(raw);
    if (!parsed) continue;
    const single = parsed.words.length === 1 && parsed.words[0]!.length === 1;
    if (single && !parsed.leading && !parsed.trailing) {
      exact.add(parsed.words[0]![0]!);
    } else {
      scan.push(parsed);
    }
  }
  // Longer phrases first so a phrase wins over a word it contains.
  scan.sort((a, b) => b.words.length - a.words.length);
  const allow = allowList
    .map(parseKeyword)
    .filter((entry): entry is ParsedKeyword => entry !== null);
  return { exact, scan, allow, isEmpty: exact.size === 0 && scan.length === 0 };
}

/**
 * The first blocked keyword in `body`, as the matched words appear in the
 * normalised text, or null when the body is clean. Allow-list spans are
 * removed from consideration first: every token an allowed phrase covers is
 * dropped, so "claim your role" on the allow list rescues a body that
 * "claim your" would block, and nothing is glued together by the removal
 * because tokens never merge.
 */
export function findBlockedKeyword(
  body: string,
  compiled: CompiledKeywords,
): string | null {
  if (compiled.isEmpty) {
    return null;
  }
  const text = normalizeForAutomod(body);
  let tokens = tokenize(text);
  if (compiled.allow.length > 0) {
    const drop = new Set<number>();
    for (const entry of compiled.allow) {
      for (const [from, to] of matchSpans(tokens, entry)) {
        for (let i = from; i <= to; i++) drop.add(i);
      }
    }
    if (drop.size > 0) {
      // Blank, never remove: a removed token would let a phrase match across
      // the gap ("free nitro" over "free lol nitro" with "lol" allowed).
      // A blank token matches nothing, exact or wildcard, so the phrase
      // stays broken where the allowed word stood.
      tokens = tokens.map((token, i) =>
        drop.has(i) ? { ...token, text: "" } : token,
      );
    }
  }
  if (compiled.exact.size > 0) {
    for (const token of tokens) {
      if (compiled.exact.has(token.text)) {
        return token.text;
      }
    }
  }
  for (const entry of compiled.scan) {
    const spans = matchSpans(tokens, entry);
    if (spans.length > 0) {
      const [from, to] = spans[0]!;
      return text.slice(tokens[from]!.start, tokens[to]!.end);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invite links
// ---------------------------------------------------------------------------

/**
 * Discord invite in any of its spellings. `discord.gg/x`, `discord.com/invite/x`,
 * `discordapp.com/invite/x`, with or without a scheme, and the `dsc.gg`
 * shortener people use to dodge the plain form. Runs on the normalised body
 * so a fullwidth or Cyrillic letter in the host does not walk past it; the
 * quantifiers are bounded, so this is the one pattern the module keeps.
 */
const DISCORD_INVITE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/[\p{L}\p{N}_-]{2,64}/iu;

export function findInviteLink(body: string): string | null {
  const match = DISCORD_INVITE_RE.exec(normalizeForAutomod(body));
  return match ? match[0] : null;
}

/** A pqp invite found in a body: the text that matched, and what it names. */
export interface PqpInviteLink {
  matched: string;
  /** `/app/invite/<code>` on any host: a server invite. */
  code?: string;
  /** `pqp.gg/c/<slug>`: a community address. */
  slug?: string;
}

/**
 * A link into pqp. `/app/invite/<code>` is pqp's own path, so it is matched on
 * any host (a self-host shares people the same way); `/c/<slug>` is too
 * generic for that (`youtube.com/c/...`) and is matched on pqp.gg only.
 * Invite codes are base64url, slugs lowercase; both bounded. Runs on the raw
 * body rather than the normalised one, because a code is case-sensitive and
 * the normaliser folds case.
 */
const PQP_INVITE_RE =
  /(?:https?:\/\/)?(?:[\w.-]{1,253}(?::\d{1,5})?)\/app\/invite\/([A-Za-z0-9_-]{4,32})|(?:https?:\/\/)?(?:www\.)?pqp\.gg\/c\/([a-z0-9][a-z0-9-]{1,63})/g;

export function findPqpInviteLinks(body: string): PqpInviteLink[] {
  const links: PqpInviteLink[] = [];
  for (const match of body.matchAll(PQP_INVITE_RE)) {
    if (match[1]) {
      links.push({ matched: match[0], code: match[1] });
    } else if (match[2]) {
      links.push({ matched: match[0], slug: match[2] });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Mention spam
// ---------------------------------------------------------------------------

/**
 * Same grammar as `MENTION_PATTERN` in `api.ts`, repeated here so this module
 * has no import from the API surface. Distinct names count once; `@everyone`
 * and `@here` count as one each, since a message that pings everyone and
 * five people is the thing the rule exists for.
 */
const MENTION_RE = /@([A-Za-z0-9_]{2,32})/g;

export function countDistinctMentions(body: string): number {
  const names = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    names.add(match[1]!.toLowerCase());
  }
  return names.size;
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

const compiledCache = new WeakMap<object, CompiledKeywords>();

/**
 * Run every enabled rule against a body and return the first verdict, or
 * null when the message may land. Exemptions (roles, channels, the
 * MANAGE_MESSAGES bypass) are the caller's job: this function is given only
 * the rules that apply to this author in this channel.
 *
 * Keyword compilation is cached per rule object, so the server can keep a
 * rule row around and pay for the regex once.
 */
export function evaluateAutomod(
  body: string,
  rules: readonly AutomodRuleInput[],
  context: AutomodContext = {},
): AutomodVerdict | null {
  for (const rule of rules) {
    if (rule.enabled === false) {
      continue;
    }
    const verdict = evaluateRule(body, rule, context);
    if (verdict) {
      return verdict;
    }
  }
  return null;
}

function evaluateRule(
  body: string,
  rule: AutomodRuleInput,
  context: AutomodContext,
): AutomodVerdict | null {
  const base = {
    kind: rule.kind,
    ...(rule.id ? { ruleId: rule.id } : {}),
    ...(rule.customMessage ? { customMessage: rule.customMessage } : {}),
  };
  switch (rule.kind) {
    case "keywords": {
      let compiled = compiledCache.get(rule);
      if (!compiled) {
        compiled = compileKeywords(rule.keywords, rule.allowList);
        compiledCache.set(rule, compiled);
      }
      const hit = findBlockedKeyword(body, compiled);
      return hit ? { ...base, matched: hit } : null;
    }
    case "invite_links": {
      const hit = findInviteLink(body);
      if (hit) {
        return { ...base, matched: hit };
      }
      if (!rule.blockPqpInvites) {
        return null;
      }
      const foreign = findPqpInviteLinks(body).find(
        (link) => !context.ownPqpInvite?.(link),
      );
      return foreign ? { ...base, matched: foreign.matched } : null;
    }
    case "mention_spam": {
      const count = countDistinctMentions(body);
      return count > rule.mentionLimit
        ? { ...base, matched: `${count} mentions` }
        : null;
    }
    default:
      return null;
  }
}
