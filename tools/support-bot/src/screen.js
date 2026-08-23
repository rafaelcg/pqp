/**
 * The last thing between a generated answer and a public channel.
 *
 * Same arrangement as `tools/ambient/src/guardrails.js`, and for the same
 * reason: the prompt asks and this enforces, and only one of the two still
 * works when the model ignores it. What is different is WHAT is being screened.
 * The ambient cast is screened for behaving like a person who says something
 * regrettable. This bot is screened for one thing above all others: asserting a
 * product fact nobody verified.
 *
 * WHY THIS IS NOT `screenLine` WITH DIFFERENT ARGUMENTS. That screen bans every
 * URL and every `@`-shaped string, which is right for a persona improvising
 * chat and wrong for a support bot whose correct answers include
 * "github.com/rafaelcg/pqp" and "pqp.gg/beta". Reusing it would mean loosening
 * it for everybody to fit one caller. The one rule that IS shared is the floor
 * that must never differ between the two, and it is imported rather than
 * copied: no account may claim to be a person.
 *
 * Pure. Every rule has a test.
 */
import { HUMANITY_CLAIM_PATTERNS } from "../../ambient/src/guardrails.js";
import { assertsE2E, harvestMeasurements } from "./facts.js";

/**
 * Hosts the bot may name. Everything else is a link it invented.
 *
 * An allowlist rather than a blocklist because the failure being prevented is
 * "the model produced a plausible URL", and plausible URLs are unbounded. The
 * list is short on purpose: these are the only two addresses any answer needs.
 */
export const ALLOWED_HOSTS = ["pqp.gg", "github.com/rafaelcg/pqp"];

/**
 * Anything that looks like a web address. Deliberately broader than the
 * allowlist so a bare `exemplo.com.br` is caught, not just `https://` links.
 */
const URLISH = /\b((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,)]*)?)/gi;

/** Hosts that are never a link even though they parse as one. */
const NOT_A_LINK = /^(v\d|\d+\.\d+)/i;

/**
 * The claims that are forbidden outright, each with the reason it is forbidden.
 *
 * These duplicate `## nunca diga` in facts.md, and the duplication is the
 * point: that section is a request to a model and this is a check on its
 * output. A rule that lives only in the prompt is a rule that holds until the
 * first surprising question.
 */
const FORBIDDEN_CLAIMS = [
  {
    reason: "legal-immunity",
    // Any claim that pqp is beyond the reach of a legal order. A hobby project
    // in Brazil is not, and saying so in public is the kind of sentence that
    // gets quoted back at its author.
    pattern:
      /\b(imune|acima da lei|fora do alcance|nem a (justi[çc]a|pol[íi]cia)|(nenhum[a]?|nem\s+um[a]?)\s+(ordem|juiz|governo|mandado)\b)/i,
  },
  {
    reason: "competitor-comparison",
    // Comparative plus a named competitor. Naming one is fine ("vim do
    // Discord"); ranking against one is a marketing claim this bot is not
    // allowed to make on the product's behalf.
    pattern:
      /\b(melhor|pior|superior|mais\s+(seguro|privado|r[áa]pido|leve|confi[áa]vel|est[áa]vel))\s+(que|do que)\s+(o\s+|a\s+)?(discord|slack|teams|telegram|whatsapp|zoom|meet)\b/i,
  },
  {
    reason: "delivery-date",
    // "When will X be ready" is the question this bot is least able to answer
    // and most likely to be believed about.
    pattern:
      /\b(em breve|logo mais|t[áa] chegando|semana que vem|m[êe]s que vem|pr[óo]xim[ao]s?\s+(dias|semanas?|m[êe]s(es)?)|at[ée]\s+(o\s+)?(fim|final)\s+d[eo]|vai (sair|ficar pronto|lan[çc]ar)\s+(em|no|na|dia|至)?)/i,
  },
  {
    reason: "advice",
    pattern:
      /\b(toma|tome|tomar)\s+\w*\s*(mg|comprimid|rem[eé]di)|\b(investe|investir|compra|comprar)\s+(em\s+)?(bitcoin|cripto|a[çc][õo]es)\b/i,
  },
];

/** How far back a negator counts, mirroring `assertsE2E` in facts.js. */
const NEGATION_WINDOW = 48;
const NEGATORS = /\b(n[ãa]o|nunca|jamais|sem|nenhum[a]?)\b/i;
const APP_STORE = /\bapp\s*store\b/gi;

/**
 * The App Store rule, which needs the same negation window E2E needs.
 *
 * "Nunca diga nada sobre a App Store" is the instruction, but a flat ban makes
 * the bot unable to answer "tá na App Store?" with the true and useful "não,
 * ainda não". Banning the truthful negative would push that question into the
 * escalation path, which spends Rafael's attention on a question the fact file
 * already answers. So: a denial passes, anything else does not.
 */
export function makesAppStoreClaim(text) {
  for (const match of String(text).matchAll(APP_STORE)) {
    const before = text.slice(
      Math.max(0, match.index - NEGATION_WINDOW),
      match.index,
    );
    if (!NEGATORS.test(before)) {
      return true;
    }
  }
  return false;
}

/**
 * Screen one candidate answer.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason, detail? }`. Every rejection
 * is logged and turned into the fallback, so a false positive costs one "não
 * sei" and a false negative costs a published lie. That asymmetry is why
 * several of these rules are tuned to fire early rather than precisely.
 */
export function screenAnswer(body, { facts, ownerHandle = null, maxLength = 420 } = {}) {
  const text = String(body ?? "").trim();

  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (text.length > maxLength) {
    return { ok: false, reason: "too-long" };
  }

  // THE EM DASH IS A CANARY, not just a style rule.
  //
  // "No em dashes" is a house rule stated twice in the prompt, in the same
  // breath as the rules about what may not be claimed. A model that produces
  // one in a two-sentence answer has demonstrably not followed a simple,
  // explicit, unmissable instruction in this response, and there is no reason
  // to trust its factual compliance in the same response any further. Rejecting
  // costs one fallback; the alternative is a rule the product enforces
  // everywhere except the one place that speaks in public automatically.
  if (/[—–]/.test(text)) {
    return { ok: false, reason: "em-dash" };
  }

  for (const pattern of HUMANITY_CLAIM_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: "humanity-claim" };
    }
  }

  if (assertsE2E(text)) {
    return { ok: false, reason: "e2e-claim" };
  }

  if (makesAppStoreClaim(text)) {
    return { ok: false, reason: "app-store-claim" };
  }

  for (const { reason, pattern } of FORBIDDEN_CLAIMS) {
    if (pattern.test(text)) {
      return { ok: false, reason };
    }
  }

  const link = disallowedLink(text);
  if (link) {
    return { ok: false, reason: "unknown-link", detail: link };
  }

  const mention = disallowedMention(text, ownerHandle);
  if (mention) {
    return { ok: false, reason: "unknown-mention", detail: mention };
  }

  const measurement = ungroundedMeasurement(text, facts);
  if (measurement) {
    return { ok: false, reason: "ungrounded-measurement", detail: measurement };
  }

  return { ok: true };
}

export function disallowedLink(text) {
  for (const match of String(text).matchAll(URLISH)) {
    // Trailing sentence punctuation is part of the sentence, not of the host.
    // Without this strip, "tá em github.com/rafaelcg/pqp." is rejected as an
    // unknown link because of the full stop, which fails a correct answer about
    // the single most linkable fact the bot has.
    const found = match[1].replace(/[.,;:!?)]+$/, "");
    const bare = found.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    if (NOT_A_LINK.test(bare)) {
      continue;
    }
    const allowed = ALLOWED_HOSTS.some(
      (host) => bare === host || bare.startsWith(`${host}/`),
    );
    if (!allowed) {
      return found;
    }
  }
  return null;
}

/**
 * The bot may ping exactly one person: the owner, in the escalation line.
 *
 * Without this an answer that happens to contain "@alguem" pings a real user
 * who did not ask to be involved, and a bot that summons strangers into a
 * thread is a bot that gets muted.
 */
export function disallowedMention(text, ownerHandle) {
  const allowed = ownerHandle ? String(ownerHandle).replace(/^@/, "").toLowerCase() : null;
  for (const match of String(text).matchAll(/@([A-Za-z0-9_]{2,32})/g)) {
    if (match[1].toLowerCase() !== allowed) {
      return `@${match[1]}`;
    }
  }
  return null;
}

/**
 * A measurement the fact file has never seen.
 *
 * This is the grounding check, and it is the single most valuable rule here
 * because invented product facts are overwhelmingly invented as numbers with
 * units. "4K", "60fps", "até 10 Mbps" all die here without anybody having to
 * predict them, because the allowed set is harvested from facts.md rather than
 * listed by hand.
 */
export function ungroundedMeasurement(text, facts) {
  if (!facts?.measurements) {
    return null;
  }
  for (const value of harvestMeasurements(text)) {
    if (!facts.measurements.has(value)) {
      return value;
    }
  }
  return null;
}
