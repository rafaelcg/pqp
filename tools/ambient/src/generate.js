/**
 * Getting a scene's dialogue — from Claude, or from a fixture.
 *
 * Two modes, one shape. `--canned` reads `fixtures/canned-scenes.json` and is
 * what CI runs: the whole pipeline — schedule, prompt, parse, guardrails,
 * typing, WebSocket, reactions — is exercised without a key and without a
 * cent. The live path differs only in where the string comes from, so a green
 * canned run really does mean the plumbing works.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildSystemPrompt, buildUserPrompt } from "./scene.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Claude Haiku 4.5. The alias, not the dated id — both resolve, and the alias
 * cannot drift out of date in a config file nobody re-reads.
 *
 * Haiku because this is the one workload where volume dominates and the task
 * is easy: six lines of chat banter in a fixed voice. Overridable per-deploy
 * so a community whose voice is not landing can be moved up a tier without a
 * code change.
 */
export const DEFAULT_MODEL = process.env.AMBIENT_MODEL ?? "claude-haiku-4-5";

/** Cost per million tokens, for the log's running total. Haiku 4.5 rates. */
const PRICE_PER_MTOK = { input: 1.0, output: 5.0 };

export function estimateCostUsd(usage) {
  if (!usage) {
    return 0;
  }
  return (
    ((usage.input_tokens ?? 0) * PRICE_PER_MTOK.input +
      (usage.output_tokens ?? 0) * PRICE_PER_MTOK.output) /
    1_000_000
  );
}

/**
 * One scene, one API call.
 *
 * `max_tokens` is sized for six short chat lines with room to spare; there is
 * no `output_config.effort` and no `thinking` because Haiku 4.5 rejects the
 * former and does not need the latter for improv dialogue.
 */
export async function generateScene({ config, plan, memory, replyTo, canned }) {
  const system = buildSystemPrompt(config, plan.cast);
  const user = buildUserPrompt({
    topic: plan.topic,
    lines: plan.lines,
    cast: plan.cast,
    memory,
    replyTo,
  });

  if (canned) {
    return {
      text: cannedTranscript(plan, replyTo),
      usage: null,
      model: "canned",
      system,
      user,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Run with --canned to exercise the " +
        "pipeline against fixture dialogue instead.",
    );
  }

  // Imported here rather than at module scope so `--canned` — and every unit
  // test — runs with the SDK absent. It is an optionalDependency for exactly
  // this reason.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return { text, usage: message.usage, model: message.model, system, user };
}

/**
 * Fixture dialogue, cast onto whoever the scheduler actually picked.
 *
 * The fixture stores lines by speaker *slot* rather than by persona id, so the
 * same fixtures work for any community's cast — which is what keeps the canned
 * path honest as a pipeline test rather than a test of one YAML file.
 */
function cannedTranscript(plan, replyTo) {
  const fixtures = JSON.parse(
    readFileSync(join(HERE, "..", "fixtures", "canned-scenes.json"), "utf8"),
  );
  const pool = replyTo ? fixtures.replies : fixtures.ambient;
  const scene = pool[Math.floor(Math.random() * pool.length)];
  const names = plan.cast.map((p) => p.displayName);

  return scene.lines
    .slice(0, plan.lines)
    .map((line) => {
      const speaker = names[line.speaker % names.length];
      const body = replyTo
        ? line.text.replaceAll("{human}", replyTo.authorName)
        : line.text;
      return `${speaker}: ${body}`;
    })
    .join("\n");
}
