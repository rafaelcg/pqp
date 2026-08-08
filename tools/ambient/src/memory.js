/**
 * What the cast remembers between scenes.
 *
 * A JSON file per community, and deliberately nothing more. The thing this
 * prevents is repetition — the same topic twice in an evening, the same
 * sentence twice in a week — and that needs a list of recent topics and a list
 * of recent lines, not a vector store. §3 of the design doc says what replaces
 * it when 5 servers becomes 50.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const EMPTY = { recentTopics: [], recentLines: [], relationships: {}, scenes: 0 };

export function loadMemory(path) {
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    // A missing or corrupt memory file is a fresh start, not an outage: the
    // worst case is one repeated topic, and refusing to run over it would take
    // a whole community offline for a cache.
    return { ...EMPTY };
  }
}

export function saveMemory(path, memory) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(memory, null, 2)}\n`);
}

/** Fold a finished scene into memory, keeping the windows bounded. */
export function rememberScene(memory, { topic, messages, cast }) {
  const recentTopics = [topic, ...memory.recentTopics].slice(0, 12);
  const recentLines = [
    ...messages.map((m) => m.body),
    ...memory.recentLines,
  ].slice(0, 120);

  // Who talks to whom. Not used for much yet — it exists so a persona can
  // eventually address the people it has actually spoken to, which is what
  // makes a cast read as a group rather than a rotation.
  const relationships = { ...memory.relationships };
  for (const a of cast) {
    for (const b of cast) {
      if (a.id === b.id) {
        continue;
      }
      const key = [a.id, b.id].sort().join("~");
      relationships[key] = (relationships[key] ?? 0) + 1;
    }
  }

  return {
    ...memory,
    recentTopics,
    recentLines,
    relationships,
    scenes: (memory.scenes ?? 0) + 1,
  };
}
