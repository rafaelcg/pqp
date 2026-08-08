/**
 * Reading a community file, and refusing a broken one at boot.
 *
 * Validation is deliberately loud and up front. The alternative — discovering
 * a malformed activity window at 22:00 when the scheduler tries to parse it —
 * is a persona that silently never speaks, which is the hardest failure in this
 * system to notice.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { parseWindow } from "./schedule.js";
import { disclosureLabel } from "./guardrails.js";

const REQUIRED_PERSONA_FIELDS = [
  "id",
  "displayName",
  "register",
  "interests",
  "activity",
];

/**
 * The languages a community may be written in.
 *
 * MIRRORS `COMMUNITY_LANGUAGES` in `@pqp/shared` and the CHECK constraint in
 * `server/src/schema.sql`, and the duplication is the same deliberate kind the
 * category list already carries: `tools/ambient` is outside the pnpm workspace
 * (see the README), so there is no `@pqp/shared` to import here. Three copies
 * that must be edited together beats a config file that can name a language the
 * database will refuse at `opt-in` time — which is the failure this catches, at
 * load, rather than halfway through an UPDATE loop.
 *
 * The value is not decoration. It picks which language the generation prompt is
 * written in (see `buildSystemPrompt`), so a community that says `en` and a cast
 * whose register notes are in English produce English chat; getting it wrong
 * produces a room that writes in neither.
 */
export const LANGUAGES = ["pt", "en"];

/**
 * Category slugs, mirrored from `COMMUNITY_CATEGORIES` in `@pqp/shared`.
 *
 * Checked here so a typo — `serie-filmes`, `esportes` — is a load-time error in
 * front of the operator rather than a CHECK-constraint violation from Postgres
 * in the middle of `opt-in-communities.mjs`, after some of the rooms are
 * already listed and some are not.
 */
export const CATEGORIES = [
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
];

export function loadConfig(path) {
  const parsed = yaml.load(readFileSync(path, "utf8"));
  return normalizeConfig(parsed, path);
}

/**
 * Read a file that may hold ONE community or ALL of them, and answer with a
 * list either way.
 *
 * The two shapes exist for one reason each. `community:` (singular) is what the
 * spike shipped and what a one-off test file still wants — a community you can
 * read top to bottom. `communities:` (plural) is the launch set, because the
 * runner now schedules every server from one process and a five-file fan-out
 * would put the shared `timezone`, `defaults` and `limits` in five places to
 * drift apart.
 *
 * Everything downstream sees the singular shape regardless, so no scheduler,
 * generator or guardrail knows there is more than one community in the world.
 * Per-community `defaults` and `limits` are merged OVER the file-level ones, so
 * a community that needs a tighter ceiling states only the number it changes.
 */
export function loadCommunities(path) {
  const parsed = yaml.load(readFileSync(path, "utf8"));
  return normalizeCommunities(parsed, path);
}

export function normalizeCommunities(raw, source = "<inline>") {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${source}: not a YAML mapping`);
  }
  if (!Array.isArray(raw.communities)) {
    return [normalizeConfig(raw, source)];
  }
  if (raw.communities.length === 0) {
    throw new Error(`${source}: \`communities\` is empty`);
  }

  const keys = new Set();
  return raw.communities.map((entry, index) => {
    const where = `${source}#${entry?.key ?? `communities[${index}]`}`;
    if (!entry || typeof entry !== "object") {
      throw new Error(`${where}: not a mapping`);
    }
    if (keys.has(entry.key)) {
      // Two communities sharing a key would share a memory file and a log
      // label, so one would silently suppress the other's topics as repeats.
      throw new Error(`${source}: duplicate community key: ${entry.key}`);
    }
    keys.add(entry.key);

    const { personas, defaults, limits, ...community } = entry;
    return normalizeConfig(
      {
        version: raw.version,
        timezone: entry.timezone ?? raw.timezone,
        community,
        defaults: { ...(raw.defaults ?? {}), ...(defaults ?? {}) },
        limits: { ...(raw.limits ?? {}), ...(limits ?? {}) },
        personas,
      },
      where,
    );
  });
}

export function normalizeConfig(raw, source = "<inline>") {
  const fail = (message) => {
    throw new Error(`${source}: ${message}`);
  };

  if (!raw || typeof raw !== "object") {
    fail("not a YAML mapping");
  }
  if (raw.version !== 1) {
    fail(`unsupported version ${raw.version} (this runner reads version 1)`);
  }
  if (!raw.timezone) {
    fail("missing `timezone`");
  }
  // Probe the zone now rather than on the first scheduler tick.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw.timezone });
  } catch {
    fail(`unknown timezone: ${raw.timezone}`);
  }

  const community = raw.community ?? fail("missing `community`");
  for (const field of ["key", "displayName", "premise", "topics"]) {
    if (!community[field]) {
      fail(`community.${field} is required`);
    }
  }
  community.channel ??= "geral";
  community.banned ??= [];

  // The listing half of a community: what the directory card says, which shelf
  // it sits on, and which language it is written in. Optional at load — the
  // runner needs none of them to hold a conversation, and a one-off test file
  // should not have to invent a category — but validated the moment they are
  // present, because the only consumer that reads them (`opt-in-communities`)
  // writes them straight into a column with a CHECK constraint behind it.
  community.language ??= "pt";
  if (!LANGUAGES.includes(community.language)) {
    fail(
      `community.language must be one of ${LANGUAGES.join(", ")} ` +
        `(got "${community.language}")`,
    );
  }
  if (community.category && !CATEGORIES.includes(community.category)) {
    fail(
      `community.category "${community.category}" is not a known slug ` +
        `(${CATEGORIES.join(", ")})`,
    );
  }

  const defaults = {
    disclosure: "character",
    locale: "pt-BR",
    maxMessagesPerHour: 6,
    ...(raw.defaults ?? {}),
  };
  // Throws on an unknown mode — the disclosure decision must never silently
  // fall through to "undisclosed" because of a typo.
  disclosureLabel(defaults.disclosure);

  const limits = {
    maxMessagesPerHourPerServer: 18,
    maxScenesPerDay: 14,
    sceneLines: [3, 6],
    maxMessageChars: 180,
    // How many reply scenes ONE person can trigger in an hour, across the whole
    // cast. The per-persona cap does not cover this: five personas with four
    // replies each is twenty answers to one visitor, which is the "swarmed by
    // strangers" failure with extra steps. Low, because a real room does not
    // answer the same person five times an hour either.
    maxRepliesPerHumanPerHour: 3,
    ...(raw.limits ?? {}),
  };
  const [minLines, maxLines] = limits.sceneLines;
  if (!(minLines >= 1 && maxLines >= minLines)) {
    fail(`limits.sceneLines must be [min, max] with 1 <= min <= max`);
  }

  const personas = raw.personas ?? [];
  if (personas.length < 2) {
    // One persona cannot hold a conversation, and the scheduler would simply
    // never cast a scene. Say so here instead.
    fail("at least 2 personas are required for a scene to have two sides");
  }

  const seen = new Set();
  for (const persona of personas) {
    for (const field of REQUIRED_PERSONA_FIELDS) {
      if (!persona[field]) {
        fail(`persona ${persona.id ?? "?"} is missing \`${field}\``);
      }
    }
    if (seen.has(persona.id)) {
      fail(`duplicate persona id: ${persona.id}`);
    }
    seen.add(persona.id);

    persona.chattiness ??= 0.5;
    persona.disclosure ??= defaults.disclosure;
    disclosureLabel(persona.disclosure);
    persona.maxMessagesPerHour ??= defaults.maxMessagesPerHour;
    persona.avatarSeed ??= persona.id;
    persona.replyToHumans ??= { enabled: false };

    /**
     * Terms THIS persona may not say, on top of the room's list.
     *
     * The room-wide list answers "what is this community not about". This
     * answers a narrower and sharper question: which character would somebody
     * naturally ask the dangerous question of. In a gym server it is the woman
     * who has trained for ten years who gets asked about a sore shoulder; in a
     * money server it is every single persona, because every one of them is one
     * "and where do you put yours?" away from giving financial advice.
     *
     * Additive only — there is no way to REMOVE a term the community banned,
     * which would be a persona quietly exempting itself from the room's rules.
     */
    if (persona.banned !== undefined && !Array.isArray(persona.banned)) {
      fail(`persona ${persona.id}: \`banned\` must be a list`);
    }
    persona.banned ??= [];

    for (const kind of ["weekday", "weekend"]) {
      const windows = persona.activity[kind] ?? [];
      for (const window of windows) {
        try {
          parseWindow(window);
        } catch (error) {
          fail(`persona ${persona.id}: ${error.message}`);
        }
      }
    }
  }

  return { version: 1, timezone: raw.timezone, community, defaults, limits, personas };
}
