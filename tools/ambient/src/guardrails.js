/**
 * The last thing between a generated line and a real channel.
 *
 * Everything here is also stated in the prompt. That duplication is the point:
 * a prompt is a request and this is a check, and the only one of the two that
 * still works when the model ignores it is this one. Pure, so every rule has a
 * test rather than an anecdote.
 */

/** Words that make a line a claim about the world we will not stand behind. */
const ADVICE_PATTERNS = [
  // Health
  /\b(toma|tome|tomar)\s+\w*\s*(mg|comprimid|rem[eé]di|antibi[oó]tic)/i,
  /\bdose\s+de\b/i,
  // Finance
  /\b(investe|investir|compra|comprar)\s+(em\s+)?(bitcoin|cripto|a[çc][õo]es|d[oó]lar)/i,
  /\brendimento\s+garantido\b/i,
  // Legal
  /\b(processa|processar|entra com\s+(uma\s+)?a[çc][ãa]o)\b/i,
];

/** Moving a stranger off-platform, or into a room. Never, from any persona. */
const OFFPLATFORM_PATTERNS = [
  /\b(zap|whatsapp|telegram|instagram|insta|discord)\b/i,
  /\b(me\s+chama|chama\s+no|manda\s+(teu|seu)\s+(n[uú]mero|contato))\b/i,
  /\b(vamos|bora|podemos)\s+(nos\s+)?(encontrar|marcar|tomar\s+um)/i,
  /\bqual\s+(teu|seu)\s+(n[uú]mero|zap|email|e-mail)\b/i,
  /@[\w.]+\.(com|br|net)\b/i,
  /\bhttps?:\/\//i,
];

/**
 * Claiming to be a person. Forbidden to EVERY account, at every disclosure
 * setting, forever — this is the floor the whole disclosure policy rests on.
 *
 * Kept apart from the software claims below because only one of the two is a
 * lie. "Sou uma pessoa real" is false whoever says it; "sou um bot" is true
 * whoever says it, and whether saying it is *allowed* is a product decision
 * carried by `disclosure`. Folding them into one list, which is what this was
 * until the support bot needed the second half, meant an account that discloses
 * could only do so by switching off the rule that stops it lying.
 */
const HUMANITY_CLAIM_PATTERNS = [
  // `\b` is not usable as the closing guard here: `ô` and `ê` are not word
  // characters to a non-unicode regex, so `rob[ôo]\b` never matches "robô" —
  // the exact string this rule exists to catch. A negative lookahead for a
  // letter does the job for accented and unaccented spellings alike.
  /\bn[ãa]o\s+sou\s+(um\s+)?(rob[ôo]|bot|ia)(?![a-zà-ú])/i,
  /\bsou\s+(uma\s+)?pessoa\s+real(?![a-zà-ú])/i,
];

/**
 * Outing itself as software. Forbidden UNLESS `disclosure` is `bot`.
 *
 * For an ambient persona this is a statement about the product made in the
 * middle of improvised dialogue, which is a decision for the server description
 * to make once rather than for a model to make per line. For an account whose
 * name already ends in " [bot]" it is simply the truth restated, and forbidding
 * it would force that account to dodge the question — which is the deception
 * the rule exists to prevent, only pointed the other way.
 */
const SOFTWARE_CLAIM_PATTERNS = [
  /\b(sou|somos)\s+(uma?\s+)?(ia|intelig[êe]ncia artificial|bot|rob[ôo]|chatbot|modelo de linguagem)(?![a-zà-ú])/i,
  /\bcomo\s+(uma?\s+)?(ia|assistente virtual)(?![a-zà-ú])/i,
];

/**
 * Somebody asking, in any spelling, whether they are talking to software.
 *
 * Kept apart from `IDENTITY_PATTERNS` because they screen opposite directions:
 * those catch a persona *claiming* something about itself, these catch a human
 * *asking*. The rule they share is that the answer is always silence — see
 * `screenInbound`.
 */
const IDENTITY_PROBE_PATTERNS = [
  // `vcs` and `vc` are how the audience actually types "vocês"/"você", so the
  // alternation carries them everywhere it carries the spelled-out form. A
  // screen that only catches correct orthography catches almost nothing here.
  /\b(voc[êe]s?|vcs?|tu|isso|isso a[íi]|aqui)\s+(é|e|s[ãa]o|tá|ta)\s+(um\s+|uma\s+)?(bot|rob[ôo]|ia|chatgpt|gpt|chatbot|ai)(?![a-zà-ú])/i,
  /\b(é|e)\s+(um\s+|uma\s+)?(bot|rob[ôo]|ia|chatbot)\s*\??/i,
  /\b(bot|rob[ôo]|ia|chatbot)\s*\?/i,
  /\b(intelig[êe]ncia artificial|modelo de linguagem|prompt|llm)\b/i,
  /\b(voc[êe]s?|vcs?|tu)\s+(s[ãa]o|é|e)\s+(gente\s+)?(de\s+)?verdade\b/i,
  /\bpessoa\s+real\b/i,
];

/**
 * Somebody being aimed at, rather than talked to.
 *
 * Not a moderation system and not trying to be — the server has one of those.
 * This is the narrow question "would replying to this amplify it", and the
 * failure it exists to prevent is the one §06 of the design doc names: a
 * character quoting, answering or reacting to a real user's harmful message
 * lends it a second voice in the room.
 */
const HOSTILITY_PATTERNS = [
  /\b(vai\s+(se\s+)?(fode?r|tomar\s+no)|fdp|filho\s+da\s+puta|arrombad[oa]|corno|viado|bicha|macac[oa]|preto\s+imundo|retardad[oa]|mongol[oó]ide)\b/i,
  /\b(te\s+mato|vou\s+te\s+(pegar|achar|matar|quebrar)|sei\s+onde\s+voc[êe]\s+mora)\b/i,
  /\b(se\s+mata|se\s+mate|vai\s+morrer)\b/i,
];

/** A message asking the room for medical / legal / financial guidance. */
const ADVICE_REQUEST_PATTERNS = [
  /\b(o que|oque)\s+(eu\s+)?(tomo|fa[çc]o)\s+(pra|para)\b/i,
  /\bposso\s+(tomar|misturar|beber)\b/i,
  /\b(vale a pena|devo)\s+(investir|comprar|vender)\b/i,
  /\b(sintoma|diagn[oó]stic|dor\s+no|advogad|processo\s+judicial)/i,
];

/**
 * Should a persona answer this real person at all?
 *
 * The runner asks this BEFORE it plans a reply scene, and the answer is a
 * verdict plus a reason for the log. Every "no" is silence — never a canned
 * refusal, never "não posso falar sobre isso", because a character that
 * announces its own rules is a character explaining that it has rules.
 *
 * The list is deliberately short and deliberately conservative. Four of the
 * five reasons are the guardrails restated as an inbound question (banned
 * topics, advice, off-platform, identity), which is the same duplication the
 * outbound screen makes and for the same reason: the generation call is also
 * asked to decline, and only one of the two still works when the model does
 * not. The fifth, hostility, exists because a reply is amplification.
 *
 * `disclosure` is the account's own setting, not the room's, and it changes
 * exactly one verdict: an identity probe. Default `undisclosed`, so every
 * existing caller keeps the behaviour it had. See the probe branch below.
 *
 * Pure. `now`, randomness and rate caps are the runner's problem — this
 * function answers only "is this message one to engage with".
 */
export function screenInbound(
  body,
  { banned = [], minLength = 2, disclosure = "undisclosed" } = {},
) {
  const text = String(body ?? "").trim();
  if (text.length < minLength) {
    return { reply: false, reason: "too-short" };
  }
  const folded = fold(text);
  for (const term of banned) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(fold(term))}`, "i");
    if (pattern.test(folded)) {
      return { reply: false, reason: `banned-topic:${term}` };
    }
  }
  for (const pattern of HOSTILITY_PATTERNS) {
    if (pattern.test(text)) {
      return { reply: false, reason: "hostile" };
    }
  }
  for (const pattern of IDENTITY_PROBE_PATTERNS) {
    if (pattern.test(text)) {
      if (disclosure === "bot") {
        // The seam a disclosed bot goes through, and the reason it is not a
        // weakening: the rule below is silence because the answer would have
        // to be *generated*, and there is no sentence a persona can improvise
        // here that is not either a lie or an unplanned product announcement.
        // An account that already carries " [bot]" in its name has a third
        // option the personas do not: a fixed sentence, written by a person,
        // that says yes. `disclose` is the instruction to post THAT and not to
        // call a model — a caller that cannot honour it must treat this as a
        // refusal, which is what `tools/ambient/src/runner.js` does.
        return { reply: true, reason: "identity-probe", disclose: true };
      }
      // The one case where silence is the *policy* and not just caution. A
      // persona may not claim to be human and may not volunteer being
      // software, so there is no sentence it can say here. Not answering is
      // the only move that keeps both halves of that rule.
      return { reply: false, reason: "identity-probe" };
    }
  }
  for (const pattern of ADVICE_REQUEST_PATTERNS) {
    if (pattern.test(text)) {
      return { reply: false, reason: "advice-request" };
    }
  }
  for (const pattern of ADVICE_PATTERNS) {
    if (pattern.test(text)) {
      return { reply: false, reason: "advice-request" };
    }
  }
  for (const pattern of OFFPLATFORM_PATTERNS) {
    if (pattern.test(text)) {
      return { reply: false, reason: "off-platform" };
    }
  }
  return { reply: true, reason: "ok" };
}

/**
 * Screen one generated line.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`. The reason is written into
 * the log for every dropped line — a guardrail that fires silently is a
 * guardrail nobody can tune.
 *
 * `disclosure: "bot"` permits one class of statement and one only: saying that
 * the speaker is software. Claiming to be a person stays forbidden at every
 * setting. Everything else on this screen is unaffected.
 */
export function screenLine(
  body,
  { banned = [], maxLength = 180, disclosure = "undisclosed" } = {},
) {
  const text = String(body ?? "").trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (text.length > maxLength) {
    return { ok: false, reason: "too-long" };
  }
  const folded = fold(text);
  for (const term of banned) {
    // Word-ish boundary on the folded form so "política" catches "politica"
    // and "POLÍTICA" but not "policial".
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(fold(term))}`, "i");
    if (pattern.test(folded)) {
      return { ok: false, reason: `banned-topic:${term}` };
    }
  }
  for (const pattern of ADVICE_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: "advice" };
    }
  }
  for (const pattern of OFFPLATFORM_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: "off-platform" };
    }
  }
  // Never conditional. Whatever `disclosure` says, no account here gets to
  // claim it is a person.
  for (const pattern of HUMANITY_CLAIM_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: "identity-claim" };
    }
  }
  if (disclosure !== "bot") {
    for (const pattern of SOFTWARE_CLAIM_PATTERNS) {
      if (pattern.test(text)) {
        return { ok: false, reason: "identity-claim" };
      }
    }
  }
  return { ok: true };
}

/**
 * Has this been said before, near enough?
 *
 * Jaccard over content words. Crude, and crude is correct at this size: the
 * failure it exists to catch is a persona posting a near-copy of its own line
 * from an hour ago, which is the single loudest tell that a channel is
 * generated. §3 of the design doc covers what replaces this at 50 servers.
 */
export function similarity(a, b) {
  const setA = tokens(a);
  const setB = tokens(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      shared += 1;
    }
  }
  return shared / (setA.size + setB.size - shared);
}

export function isTooSimilar(body, recent, threshold = 0.6) {
  return recent.some((previous) => similarity(body, previous) >= threshold);
}

const STOPWORDS = new Set([
  "a", "o", "as", "os", "de", "do", "da", "dos", "das", "em", "no", "na",
  "um", "uma", "e", "que", "pra", "para", "com", "se", "eu", "ele", "ela",
  "mas", "ja", "nao", "sim", "ai", "ta", "e",
]);

function tokens(value) {
  return new Set(
    fold(value)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function fold(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The suffix a persona's display name carries, per disclosure mode.
 *
 * This is the whole implementation of the reversible-disclosure promise: the
 * policy is a string in YAML, and switching it rewrites what every account is
 * called on its next profile sync. Nothing else in the runner branches on it.
 */
export function disclosureLabel(mode) {
  switch (mode) {
    case "bot":
      return { suffix: " [bot]", bio: "Conta automatizada da casa." };
    case "character":
      return {
        suffix: "",
        bio: "Personagem da casa — perfil fictício mantido pela equipe do pqp.",
      };
    case "undisclosed":
      return { suffix: "", bio: null };
    default:
      throw new Error(`Unknown disclosure mode: ${mode}`);
  }
}
