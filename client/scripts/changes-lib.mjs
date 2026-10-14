/**
 * The pure half of `build-changes.mjs`: what the deploy writes to
 * `/changes.json`, which the update popover reads (`src/lib/update-changes.ts`).
 *
 * A change is a merged pull request that touched the web client. It becomes a
 * LINE in the popover only if its author wrote one for the person: a line in
 * the commit message (a squash merge keeps the commit messages of the branch),
 *
 *     Update note (pt-BR): Agora dá para arrastar os servidores na barra.
 *     Update note (en): You can now drag your servers in the rail.
 *     Update note (es): Ahora puedes arrastrar tus servidores en la barra.
 *
 * Any subset of the three. A pull request title is written for a reviewer, in
 * English, and is never quoted to a person; a change with no note is only
 * counted ("and 7 more small improvements").
 */

export const MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const MAX_ENTRIES = 80;
const MAX_NOTE_LENGTH = 140;

const LOCALES = new Map([
  ["en", "en"],
  ["pt-br", "pt-BR"],
  ["pt", "pt-BR"],
  ["es", "es"],
]);

/** `Update note (pt-BR): text`, one per line, in a commit body. Bullets and indentation are tolerated. */
const NOTE_LINE = /^\s*(?:[-*]\s+)?update note\s*\(\s*([a-z-]+)\s*\)\s*:\s*(.+?)\s*$/i;

/**
 * @param {string} body a commit message body
 * @returns {Record<string, string>} locale to sentence, for the locales that were given
 */
export function extractNotes(body) {
  /** @type {Record<string, string>} */
  const notes = {};
  for (const line of String(body ?? "").split("\n")) {
    const match = NOTE_LINE.exec(line);
    if (!match) {
      continue;
    }
    const locale = LOCALES.get(match[1].toLowerCase());
    const text = match[2].replace(/\s+/g, " ").trim();
    if (locale && text.length > 0 && text.length <= MAX_NOTE_LENGTH && !(locale in notes)) {
      notes[locale] = text;
    }
  }
  return notes;
}

/** The pull request number a squash merge names in its subject: `Title (#1211)`. */
export function prFromSubject(subject) {
  const match = /\(#(\d+)\)\s*$/.exec(String(subject ?? "").trim());
  return match ? Number(match[1]) : null;
}

const RECORD = "\x1e";
const FIELD = "\x1f";

/**
 * `git log --format=%H<US>%ct<US>%s<US>%b<RS>`, as entries. A merge's
 * committer time is the moment it landed on main, which is what the client
 * compares to its own build time.
 *
 * @param {string} raw
 * @returns {{ pr: number | null, at: number, note: Record<string, string> }[]}
 */
export function parseLog(raw) {
  const entries = [];
  for (const record of String(raw ?? "").split(RECORD)) {
    const trimmed = record.replace(/^\s+/, "");
    if (!trimmed) {
      continue;
    }
    const [, seconds, subject, ...rest] = trimmed.split(FIELD);
    const at = Number(seconds) * 1000;
    if (!Number.isFinite(at) || at <= 0) {
      continue;
    }
    entries.push({
      pr: prFromSubject(subject),
      at,
      note: extractNotes(rest.join(FIELD)),
    });
  }
  return entries;
}

/** The `--format` that `parseLog` reads. */
export const LOG_FORMAT = `%H${FIELD}%ct${FIELD}%s${FIELD}%b${RECORD}`;

/**
 * Add a deploy's changes to what the last deploy published, drop what is too
 * old to matter, and cap the file. A pull request already listed is replaced by
 * the newer reading of it (a note added later wins).
 *
 * @param {unknown} previous the `changes.json` that is live now, parsed, or anything
 * @param {{ pr: number | null, at: number, note: Record<string, string> }[]} fresh
 * @param {number} now
 */
export function mergeChanges(previous, fresh, now) {
  const old = Array.isArray(previous?.entries) ? previous.entries : [];
  const byKey = new Map();
  const keyOf = (entry, index) =>
    entry.pr !== null && entry.pr !== undefined ? `pr:${entry.pr}` : `at:${entry.at}:${index}`;
  [...old, ...fresh].forEach((entry, index) => {
    if (!entry || typeof entry.at !== "number" || !Number.isFinite(entry.at)) {
      return;
    }
    byKey.set(keyOf(entry, index), {
      pr: typeof entry.pr === "number" ? entry.pr : null,
      at: entry.at,
      note: typeof entry.note === "object" && entry.note ? entry.note : {},
    });
  });
  const kept = [...byKey.values()]
    .filter((entry) => now - entry.at <= MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
  return { generatedAt: now, entries: kept };
}
