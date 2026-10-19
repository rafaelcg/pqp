import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuiltApp, buildApp } from "./bundle.mts";
import {
  CATALOG_PATH,
  type Catalog,
  type CatalogEntry,
  immutabilityViolations,
  parseCatalog,
  readBaseCatalog,
  renderCatalog,
  sortByIdAndVersion,
} from "./catalog.mts";
import { renderHeaders, ruleForVersion } from "./headers.mts";

/** The repository root, found from this file so the CLI works from any directory. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface BuildAllOptions {
  repoRoot?: string;
  /** Where `<id>/<version>/` folders and `_headers` go. */
  outDir: string;
  /** Build only these app folders (names under `apps/`). Default: every folder with a manifest source. */
  only?: string[];
}

export interface BuildAllResult {
  apps: BuiltApp[];
  headers: string;
  catalogText: string;
  catalog: Catalog;
}

export function appFolders(repoRoot: string): string[] {
  const root = join(repoRoot, "apps");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "manifest.source.json")))
    .map((entry) => entry.name)
    .sort();
}

/** Builds every app into `outDir` and returns what the catalog and `_headers` should say. */
export async function buildAll(options: BuildAllOptions): Promise<BuildAllResult> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const folders = options.only ?? appFolders(repoRoot);
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  const apps: BuiltApp[] = [];
  // one at a time: each is a Vite build, and the output order must not depend on timing
  for (const folder of folders) {
    apps.push(await buildApp(join(repoRoot, "apps", folder), options.outDir));
  }

  const seen = new Set<string>();
  for (const app of apps) {
    const key = `${app.manifest.id}@${app.manifest.version}`;
    if (seen.has(key)) throw new Error(`two app folders build ${key}`);
    seen.add(key);
  }

  const entries: CatalogEntry[] = apps.map((app) => ({
    manifest: app.manifest,
    manifestSha256: app.manifestSha256,
  }));
  const headers = renderHeaders(sortByIdAndVersion(apps).map((app) => ruleForVersion(app.manifest)));
  writeFileSync(join(options.outDir, "_headers"), headers);

  const catalogText = renderCatalog(entries);
  return { apps, headers, catalogText, catalog: parseCatalog(catalogText, "the build") };
}

export interface ImmutabilityOutcome {
  status: "ok" | "skipped";
  violations: string[];
  note?: string;
}

/**
 * Compares the build with the catalog on `origin/main`. With no `origin/main`
 * ref (a fresh clone of a fork, a shallow CI checkout that did not fetch it)
 * the check is skipped with a note, unless `require` is set, which CI does.
 */
export function checkImmutability(repoRoot: string, next: Catalog, require: boolean): ImmutabilityOutcome {
  const base = readBaseCatalog(repoRoot);
  if (base.kind === "no-ref") {
    if (require) {
      return { status: "ok", violations: ["origin/main is not available, so version immutability cannot be checked (fetch it first)"] };
    }
    return { status: "skipped", violations: [], note: "origin/main not found, version immutability not checked" };
  }
  if (base.kind === "empty") return { status: "ok", violations: [] };
  return { status: "ok", violations: immutabilityViolations(base.catalog, next) };
}

export function committedCatalog(repoRoot: string): string | null {
  const file = join(repoRoot, CATALOG_PATH);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function catalogFile(repoRoot: string): string {
  return join(repoRoot, CATALOG_PATH);
}
