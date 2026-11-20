/**
 * Where the wire fixtures live, how they are serialised, and the one command
 * line both generators share: write, or `--check` (regenerate in memory and fail
 * when the committed file differs, writing nothing).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROTO_VECTORS_URL = new URL("../fixtures/wire/proto-vectors.json", import.meta.url);
export const CONSTRAINTS_URL = new URL("../fixtures/wire/constraints.json", import.meta.url);

/** The exact bytes a fixture is committed as. */
export const serialise = (fixture) => `${JSON.stringify(fixture, null, 2)}\n`;

/** True when `importMetaUrl` is the file `node` was started on, not an importer. */
export const isMain = (importMetaUrl) => {
  const entry = process.argv[1];
  return Boolean(entry) && importMetaUrl === pathToFileURL(entry).href;
};

/**
 * Write the fixture, or with `--check` compare it. `--check` exists so a person
 * (and `pnpm fixtures:wire:check`) can ask "is what is committed what the
 * schemas say today" without touching the tree; the vitest suite asks the same
 * question in memory.
 */
export function runCli({ script, url, fixture, summary }) {
  const text = serialise(fixture);
  const file = fileURLToPath(url);
  if (process.argv.includes("--check")) {
    let committed = null;
    try { committed = readFileSync(file, "utf8"); } catch { /* reported below */ }
    if (committed !== text) {
      console.error(
        `${script}: the committed fixture is out of date (or missing). `
        + "Run `pnpm fixtures:wire` and commit the result.",
      );
      process.exit(1);
    }
    console.log(`${script}: the committed fixture matches. ${summary}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`${summary}\n  -> ${file}`);
}
