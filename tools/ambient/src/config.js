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

export function loadConfig(path) {
  const parsed = yaml.load(readFileSync(path, "utf8"));
  return normalizeConfig(parsed, path);
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
