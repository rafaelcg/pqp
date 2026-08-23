/**
 * The fact file, loaded and checked.
 *
 * `facts.md` is the whole content surface of this bot, the way `personas.yaml`
 * is the ambient runner's. Everything the bot is allowed to assert lives there
 * and nowhere else, which is the property the entire design rests on: when a
 * fact goes stale, there is exactly one place to fix it and no code to ship.
 *
 * WHY MARKDOWN AND NOT YAML OR JSON. A person maintains this under time
 * pressure, usually right after discovering a published claim is wrong. YAML
 * would put a schema between that person and the fix, and the schema would buy
 * nothing: the file's consumer is a language model, which wants prose. Markdown
 * headings give the maintainer structure without giving them a way to break the
 * parse.
 *
 * WHY THE FILE IS SPLIT. Everything above `<!-- fim dos fatos -->` is pasted
 * into the prompt verbatim. Everything below is for the maintainer: where each
 * number came from, so the next person can re-verify it against the code rather
 * than trusting this file the way the bot does. Sending that half to the model
 * would spend tokens teaching it about `peer-connection-manager.ts`, which is
 * not a thing any user will ever ask about.
 */
import { readFileSync } from "node:fs";

/** The one structural thing the file must contain. */
export const MAINTAINER_MARKER = "<!-- fim dos fatos -->";

/**
 * Headings the prompt refers to by name. If a maintainer renames or deletes
 * one, the prompt starts pointing at a section that is not there and the bot
 * quietly loses a rule, which is the single worst failure this file can have.
 * So it is a load error rather than a silent degradation. Same trade
 * `config.js` makes in the ambient runner: fail at boot, not at 22:00.
 */
const REQUIRED_SECTIONS = ["nunca diga", "não sei"];

/**
 * Numbers the bot is allowed to say, harvested from the facts themselves.
 *
 * This is the grounding vocabulary for `screenAnswer`. The point is narrow and
 * worth stating precisely: a model that invents a product fact almost always
 * invents it as a NUMBER WITH A UNIT. "4K", "60fps", "10 Mbps", "até 20
 * pessoas". Prose hallucinations are hard to catch mechanically; those are not,
 * because a measurement the fact file has never seen is a measurement nobody
 * verified.
 *
 * Harvested rather than hand-listed so the check cannot drift away from the
 * facts. Adding "1440p" to facts.md automatically permits the bot to say it.
 */
const MEASUREMENT_PATTERN =
  /(\d+(?:[.,]\d+)?)\s*(k|p|fps|mbps|kbps|gb|mb|kb|ms|hz|bps)\b/gi;

/**
 * Sections whose numbers are FORBIDDEN rather than permitted.
 *
 * This is not a detail, it is a bug the first version shipped. "Nunca diga 4K"
 * lives in `## nunca diga`, and a harvest over the whole file dutifully learned
 * `4k` as an approved measurement, so the one number the fact file explicitly
 * bans became the one number the screen explicitly allowed. A prohibition has
 * to be read as a prohibition even by the code that is only counting digits.
 */
const PROHIBITION_SECTIONS = new Set(["nunca diga", "não sei"]);

/**
 * Split on `##` headings so a section can be excluded by name. Returns
 * `[{ heading, body }]`; anything before the first heading is `heading: null`
 * and counts as affirmative, which is right for the file's preamble.
 */
export function splitSections(text) {
  const sections = [];
  let heading = null;
  let body = [];
  for (const line of String(text).split("\n")) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) {
      sections.push({ heading, body: body.join("\n") });
      heading = match[1].trim().toLowerCase();
      body = [];
    } else {
      body.push(line);
    }
  }
  sections.push({ heading, body: body.join("\n") });
  return sections;
}

export function harvestMeasurements(text) {
  const found = new Set();
  for (const section of splitSections(text)) {
    if (section.heading && PROHIBITION_SECTIONS.has(section.heading)) {
      continue;
    }
    for (const match of section.body.matchAll(MEASUREMENT_PATTERN)) {
      found.add(normalizeMeasurement(match[1], match[2]));
    }
  }
  return found;
}

/**
 * `2,5 Mbps`, `2.5 mbps` and `2,5MBPS` are the same claim written by three
 * different people. Portuguese uses the comma as a decimal separator and the
 * model will produce both, so the comparison has to happen on a normal form or
 * the screen fires on a correct answer.
 */
export function normalizeMeasurement(value, unit) {
  return `${String(value).replace(",", ".")}${String(unit).toLowerCase()}`;
}

export function loadFacts(path) {
  const raw = readFileSync(path, "utf8");
  return parseFacts(raw, path);
}

export function parseFacts(raw, source = "<inline>") {
  const index = raw.indexOf(MAINTAINER_MARKER);
  if (index < 0) {
    throw new Error(
      `${source}: no ${MAINTAINER_MARKER} marker. Everything above it is sent ` +
        `to the model and everything below it is maintainer notes, so a file ` +
        `without it has no defined boundary and would leak the notes into the ` +
        `prompt.`,
    );
  }

  const text = raw.slice(0, index).trim();
  if (text.length === 0) {
    throw new Error(`${source}: the fact section is empty`);
  }

  const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) =>
    m[1].trim().toLowerCase(),
  );
  const missing = REQUIRED_SECTIONS.filter((s) => !headings.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `${source}: missing required section(s): ${missing.join(", ")}. ` +
        `The prompt refers to these by name; without them the bot loses a ` +
        `rule without anybody noticing.`,
    );
  }

  // A rule stated in the facts and contradicted by the facts is worse than
  // either alone, and this is the one contradiction worth spending a check on
  // because it is the claim with the highest cost of being wrong.
  //
  // The negation window is not optional and the first draft got it wrong: the
  // file's own prohibition ("nunca diga que o pqp TEM criptografia de ponta a
  // ponta") contains the exact phrase this looks for, so a naive match fires on
  // the sentence that exists to prevent the thing. Anything is an assertion
  // unless a negator appears shortly before it.
  if (assertsE2E(text)) {
    throw new Error(
      `${source}: the fact file appears to assert end-to-end encryption. ` +
        `pqp does not have it, and this is the one claim the bot may never make.`,
    );
  }

  return {
    source,
    text,
    headings,
    measurements: harvestMeasurements(text),
  };
}

/** How far back a negator counts. Long enough for "nunca diga que o pqp ...". */
const NEGATION_WINDOW = 48;
const NEGATORS = /\b(n[ãa]o|nunca|jamais|sem|nenhum[a]?)\b/i;
/**
 * The phrase, not the verb.
 *
 * The first version of this enumerated verbs ("tem|possui|usa|oferece") and
 * shipped a hole big enough to drive the whole product through: "as mensagens
 * TÊM criptografia de ponta a ponta" sailed past, because `têm` is not `tem`
 * once you have a circumflex, and Portuguese conjugation is not something a
 * safety rule should be betting on. Matching the CLAIM SHAPE instead - the
 * phrase "ponta a ponta" and its English and abbreviated forms, wherever it
 * appears - has no such surface. It over-matches by design; the negation window
 * is what keeps the honest denial legal.
 */
const E2E_CLAIM = /(ponta\s+a\s+ponta|end[\s-]?to[\s-]?end|\be2ee?\b)/gi;

/**
 * Does this text ASSERT end-to-end encryption, as opposed to denying it or
 * forbidding the claim?
 *
 * Exported because the outbound screen needs exactly the same judgement about
 * a generated answer, and two copies of a rule this load-bearing would drift.
 */
export function assertsE2E(text) {
  for (const match of String(text).matchAll(E2E_CLAIM)) {
    const before = text.slice(Math.max(0, match.index - NEGATION_WINDOW), match.index);
    if (!NEGATORS.test(before)) {
      return true;
    }
  }
  return false;
}
