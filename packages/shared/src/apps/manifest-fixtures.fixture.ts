/**
 * Loads `fixtures/app-manifests/` and `schemas/app-manifest-1.schema.json`
 * for the manifest tests. This package has no Node types and its rootDir is
 * `src`, so the file system is reached through a variable specifier and a
 * minimal local type, the way `channel-layout.test.ts` loads its JSON.
 */

interface NodeFs {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}

const NODE_FS = "node:fs";
const fs = (await import(/* @vite-ignore */ NODE_FS)) as NodeFs;

const meta = import.meta as unknown as { url: string };
const FIXTURES_DIR = new URL("../../fixtures/app-manifests/", meta.url);
const SCHEMA_FILE = new URL("../../schemas/app-manifest-1.schema.json", meta.url);

export function fixtureNames(): string[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

export function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`${name}.json`, FIXTURES_DIR), "utf8"));
}

export function readManifestJsonSchema(): object {
  return JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")) as object;
}
