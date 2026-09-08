import { z } from "zod";

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
 * - `invite_links`: a Discord invite in the body. Opt-in.
 * - `mention_spam`: more than N distinct mentions in one message. Opt-in.
 *
 * The action is always block-and-tell: the message never lands and the
 * author gets `message-rejected` with `reason: "automod"` plus the rule's own
 * `customMessage`. Timeout-on-trip and regex triggers are deliberately not
 * here; see the issue for why.
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
  /** Also file a report on the instance-style reports queue for the server. */
  reportHits: z.boolean(),
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
    reportHits: true,
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
> & { id?: string; customMessage?: string; enabled?: boolean };

export interface AutomodVerdict {
  kind: AutomodRuleKind;
  ruleId?: string;
  /** The word, link or count that tripped the rule, for the audit row. */
  matched: string;
  customMessage?: string;
}

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
 * marks, drop the invisibles, map the handful of homoglyphs, lowercase, and
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
    .replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] ?? ch)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/** `\b` is ASCII-only; these are the unicode-aware edges of a word. */
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";
const WORD_CHARS = "[\\p{L}\\p{N}_]*";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One keyword to one pattern source. Exported for the settings preview,
 * which shows what a wildcard expands to.
 *
 * `*` at either end removes that edge's word boundary; `*` in the middle
 * matches any run of word characters. Spaces in a phrase match any
 * whitespace. Everything else is literal. An entry of only wildcards is
 * dropped, because it would match every message.
 */
export function keywordToPatternSource(keyword: string): string | null {
  const normalized = normalizeForAutomod(keyword);
  const leading = normalized.startsWith("*");
  const trailing = normalized.endsWith("*") && normalized.length > 1;
  const core = normalized.replace(/^\*+/, "").replace(/\*+$/, "");
  if (!core || !/[\p{L}\p{N}]/u.test(core)) {
    return null;
  }
  const body = core
    .split(/\*+/)
    .map((part) => escapeRegex(part).replace(/ /g, "\\s+"))
    .join(WORD_CHARS);
  // A wildcard edge still swallows the rest of the word, so the verdict
  // reports `scammer`, not the `scam` fragment that tripped it.
  return `${leading ? WORD_CHARS : WORD_START}${body}${trailing ? WORD_CHARS : WORD_END}`;
}

export interface CompiledKeywords {
  /** Null when no entry survived compilation: nothing to match. */
  pattern: RegExp | null;
  /** Allow-list entries, compiled the same way. Null when empty. */
  allow: RegExp | null;
}

/**
 * Compile a keyword list once per rule. The result is one alternation, so a
 * thousand keywords are one pass over the body. `allow` spans are blanked
 * out of the body before `pattern` runs, which is what makes "claim your
 * role" on the allow list rescue a message that "claim your" would block.
 */
export function compileKeywords(
  keywords: readonly string[],
  allowList: readonly string[] = [],
): CompiledKeywords {
  const toRegExp = (entries: readonly string[]): RegExp | null => {
    const sources = entries
      .map(keywordToPatternSource)
      .filter((source): source is string => source !== null);
    if (sources.length === 0) {
      return null;
    }
    // Longest first so a phrase wins over a word it contains.
    sources.sort((a, b) => b.length - a.length);
    return new RegExp(sources.map((s) => `(?:${s})`).join("|"), "giu");
  };
  return { pattern: toRegExp(keywords), allow: toRegExp(allowList) };
}

/**
 * The first blocked keyword in `body`, as it appeared after normalisation,
 * or null when the body is clean.
 */
export function findBlockedKeyword(
  body: string,
  compiled: CompiledKeywords,
): string | null {
  if (!compiled.pattern) {
    return null;
  }
  let text = normalizeForAutomod(body);
  if (compiled.allow) {
    // Blank, never remove: removing would glue neighbours into a new word.
    text = text.replace(compiled.allow, (hit) => " ".repeat(hit.length));
  }
  compiled.pattern.lastIndex = 0;
  const match = compiled.pattern.exec(text);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Invite links
// ---------------------------------------------------------------------------

/**
 * Discord invite in any of its spellings. `discord.gg/x`, `discord.com/invite/x`,
 * `discordapp.com/invite/x`, with or without a scheme, and the `dsc.gg`
 * shortener people use to dodge the plain form.
 */
const DISCORD_INVITE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/[\w-]{2,}/i;

export function findInviteLink(body: string): string | null {
  const match = DISCORD_INVITE_RE.exec(body.replace(INVISIBLE_RE, ""));
  return match ? match[0] : null;
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
): AutomodVerdict | null {
  for (const rule of rules) {
    if (rule.enabled === false) {
      continue;
    }
    const verdict = evaluateRule(body, rule);
    if (verdict) {
      return verdict;
    }
  }
  return null;
}

function evaluateRule(
  body: string,
  rule: AutomodRuleInput,
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
      return hit ? { ...base, matched: hit } : null;
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
