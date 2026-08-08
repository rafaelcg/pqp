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
 * A persona must not claim to be human, and must not out itself as software
 * unless disclosure says so — either one turns the character into a statement
 * about the product, which is a decision for the server description, not for a
 * line of improvised dialogue.
 */
const IDENTITY_PATTERNS = [
  // `\b` is not usable as the closing guard here: `ô` and `ê` are not word
  // characters to a non-unicode regex, so `rob[ôo]\b` never matches "robô" —
  // the exact string this rule exists to catch. A negative lookahead for a
  // letter does the job for accented and unaccented spellings alike.
  /\b(sou|somos)\s+(uma?\s+)?(ia|intelig[êe]ncia artificial|bot|rob[ôo]|chatbot|modelo de linguagem)(?![a-zà-ú])/i,
  /\bn[ãa]o\s+sou\s+(um\s+)?(rob[ôo]|bot|ia)(?![a-zà-ú])/i,
  /\bsou\s+(uma\s+)?pessoa\s+real(?![a-zà-ú])/i,
  /\bcomo\s+(uma?\s+)?(ia|assistente virtual)(?![a-zà-ú])/i,
];

/**
 * Screen one generated line.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`. The reason is written into
 * the log for every dropped line — a guardrail that fires silently is a
 * guardrail nobody can tune.
 */
export function screenLine(body, { banned = [], maxLength = 180 } = {}) {
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
  for (const pattern of IDENTITY_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: "identity-claim" };
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
