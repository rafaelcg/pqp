import { execFileSync } from "node:child_process";
import { type AppManifest, validateAppManifest } from "@pqp/shared";
import { manifestSha256 } from "./hash.mts";

export interface CatalogEntry {
  manifest: AppManifest;
  manifestSha256: string;
}

export interface Catalog {
  apps: CatalogEntry[];
}

/** Where the server reads the catalog from, relative to the repository root. */
export const CATALOG_PATH = "server/src/apps/catalog.json";

/** The ref a PR's catalog is compared with for version immutability. */
export const BASE_REF = "origin/main";

/** Plain code unit order: the same on every machine, unlike `localeCompare`. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted by id, then version. */
export function sortByIdAndVersion<T extends { manifest: Pick<AppManifest, "id" | "version"> }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.manifest.id === b.manifest.id
      ? compare(a.manifest.version, b.manifest.version)
      : compare(a.manifest.id, b.manifest.id),
  );
}

/** The committed text: sorted by id then version, two-space JSON, trailing newline. */
export function renderCatalog(entries: CatalogEntry[]): string {
  return `${JSON.stringify({ apps: sortByIdAndVersion(entries) }, null, 2)}\n`;
}

export function parseCatalog(text: string, where: string): Catalog {
  const data = JSON.parse(text) as { apps?: unknown };
  if (!data || !Array.isArray(data.apps)) throw new Error(`${where}: expected { "apps": [...] }`);
  const apps: CatalogEntry[] = [];
  for (const [index, raw] of data.apps.entries()) {
    const entry = raw as { manifest?: unknown; manifestSha256?: unknown };
    const result = validateAppManifest(entry.manifest);
    if (!result.ok) throw new Error(`${where}: apps[${index}].manifest is not valid (${result.issues[0]?.path}: ${result.issues[0]?.message})`);
    if (typeof entry.manifestSha256 !== "string") throw new Error(`${where}: apps[${index}].manifestSha256 is missing`);
    apps.push({ manifest: result.manifest, manifestSha256: entry.manifestSha256 });
  }
  return { apps };
}

/** Entries whose recorded hash is not the hash of their manifest. */
export function inconsistentEntries(catalog: Catalog): string[] {
  return catalog.apps
    .filter((entry) => manifestSha256(entry.manifest) !== entry.manifestSha256)
    .map((entry) => `${entry.manifest.id}@${entry.manifest.version}`);
}

/**
 * A version is immutable: an (id, version) that is already in the base catalog
 * must come out of this build with the same `manifestSha256`. A different hash
 * means the bytes changed without a new version, and a session pinned to that
 * version would load code its reviewer never saw.
 */
export function immutabilityViolations(base: Catalog, next: Catalog): string[] {
  const nextByKey = new Map(next.apps.map((e) => [`${e.manifest.id}@${e.manifest.version}`, e]));
  const out: string[] = [];
  for (const old of base.apps) {
    const key = `${old.manifest.id}@${old.manifest.version}`;
    const now = nextByKey.get(key);
    if (now && now.manifestSha256 !== old.manifestSha256) {
      out.push(
        `${key} is already in ${BASE_REF} with manifestSha256 ${old.manifestSha256.slice(0, 12)} and now builds to ${now.manifestSha256.slice(0, 12)}: bump the version of ${old.manifest.id} in apps/*/manifest.source.json`,
      );
    }
  }
  return out;
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export type BaseCatalog =
  | { kind: "found"; catalog: Catalog }
  /** `origin/main` exists and has no catalog yet (the PR that introduces it). */
  | { kind: "empty" }
  | { kind: "no-ref" };

/** The catalog on `origin/main`, read from git. */
export function readBaseCatalog(repoRoot: string): BaseCatalog {
  if (git(repoRoot, ["rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`]) === null) {
    return { kind: "no-ref" };
  }
  const text = git(repoRoot, ["show", `${BASE_REF}:${CATALOG_PATH}`]);
  if (text === null) return { kind: "empty" };
  return { kind: "found", catalog: parseCatalog(text, `${BASE_REF}:${CATALOG_PATH}`) };
}
