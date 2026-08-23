/**
 * One question, one model call.
 *
 * Mirrors `tools/ambient/src/generate.js` deliberately, including `--canned`:
 * the fixture path exercises the whole pipeline - trigger, prompt, parse,
 * screen, budget, socket - with no key and no cost, which is what makes the
 * test suite and a local demo the same code path as production.
 *
 * ── MODEL CHOICE ────────────────────────────────────────────────────────────
 *
 * Haiku 4.5, matching the sibling runner, and the reasoning is the thesis of
 * this whole tool rather than a cost saving. Correctness here does not come
 * from the model being clever. It comes from the fact file being the only
 * source, the `NAO_SEI` sentinel making ignorance a control-flow decision, and
 * `screenAnswer` refusing an ungrounded claim deterministically whatever the
 * model produced. The task is a lookup over 4KB of pasted text, which is the
 * shape a small model is good at.
 *
 * `SUPPORT_MODEL` moves it up a tier without a code change if the answers read
 * badly. That is the knob to reach for, and the cost table in the README says
 * what each tier does to the monthly bill.
 */
import { buildSystemPrompt, buildUserPrompt } from "./answer.js";

export const DEFAULT_MODEL = process.env.SUPPORT_MODEL ?? "claude-haiku-4-5";

/**
 * Cost per million tokens, for the budget ledger.
 *
 * A table rather than one pair because `SUPPORT_MODEL` can move the model and a
 * budget that keeps charging Haiku rates for a Sonnet call is a ceiling that
 * does not hold. Unknown models fall back to the most expensive row: an
 * over-estimate stops the bot early, an under-estimate lets it overspend, and
 * only one of those two is recoverable.
 */
const PRICE_PER_MTOK = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
};
const FALLBACK_PRICE = { input: 15.0, output: 75.0 };

export function priceFor(model) {
  return PRICE_PER_MTOK[model] ?? FALLBACK_PRICE;
}

export function estimateCostUsd(usage, model = DEFAULT_MODEL) {
  if (!usage) {
    return 0;
  }
  const price = priceFor(model);
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output) /
    1_000_000
  );
}

/**
 * Ask the model.
 *
 * `max_tokens` is small on purpose. The answer is three sentences; a ceiling
 * that cannot fit an essay is one more thing keeping the output short, and it
 * also bounds the cost of a single pathological response.
 */
export async function generateAnswer({
  facts,
  question,
  transcript,
  authorName,
  maxChars,
  canned = null,
}) {
  const system = buildSystemPrompt(facts, { maxChars });
  const user = buildUserPrompt({ question, transcript, authorName });

  if (canned) {
    // The fixture is a function of the question so a test can drive both
    // branches (a known answer and the sentinel) without a key.
    return { text: canned(question), usage: null, model: "canned", system, user };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Run with --canned to exercise the " +
        "pipeline against fixture answers instead.",
    );
  }

  // Imported lazily so `--canned` and every unit test run with the SDK absent.
  // It is an optionalDependency for exactly this reason.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 400,
    // Deterministic-ish. This is a lookup, not a creative task, and two people
    // asking the same question a week apart should get the same answer.
    temperature: 0,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return { text, usage: message.usage, model: message.model, system, user };
}
