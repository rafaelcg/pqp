import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { build } from "vite";
import {
  type AppManifest,
  type AppManifestIssue,
  type AppManifestSource,
  validateAppManifest,
} from "@pqp/shared";
import { addIntegrity } from "./html.mts";
import { manifestSha256, sha256Hex } from "./hash.mts";

export interface BundleFile {
  /** Path inside the version folder, posix separators. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface BuiltApp {
  manifest: AppManifest;
  manifestSha256: string;
  /** Every file of the bundle, sorted by path. */
  files: BundleFile[];
  /** Where the version folder was written. */
  outDir: string;
}

function describe(issues: AppManifestIssue[]): string {
  return issues.map((issue) => `  ${issue.path || "(root)"} [${issue.code}] ${issue.message}`).join("\n");
}

export function readSourceManifest(appDir: string): AppManifestSource {
  const file = join(appDir, "manifest.source.json");
  const result = validateAppManifest(JSON.parse(readFileSync(file, "utf8")) as unknown, { source: true });
  if (!result.ok) throw new Error(`${file} is not a valid manifest source:\n${describe(result.issues)}`);
  return result.manifest;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function listFiles(outDir: string): BundleFile[] {
  return walk(outDir)
    .map((full) => {
      const data = readFileSync(full);
      return {
        path: relative(outDir, full).split(sep).join(posix.sep),
        sha256: sha256Hex(data),
        bytes: data.length,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Builds one app into `<outRoot>/<id>/<version>/`.
 *
 * The Vite output is deterministic on purpose: fixed file names (no content
 * hash in a name, the version folder is already immutable), one script, one
 * stylesheet, no source maps, no module preload shim, nothing inlined (an
 * inline script or `data:` font would be refused by the frame's CSP anyway).
 * Then the entry page gets SRI, every file is hashed, and the built manifest
 * is the source with `entry.sha256` and `assets[].sha256/bytes` filled in.
 */
export async function buildApp(appDir: string, outRoot: string): Promise<BuiltApp> {
  const source = readSourceManifest(appDir);
  if (source.entry.path !== "index.html") {
    throw new Error(`${appDir}: entry.path must be "index.html" (a Vite app), got "${source.entry.path}"`);
  }
  const outDir = join(outRoot, source.id, source.version);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await build({
    // Vite compares real paths, so a symlinked folder (macOS /var, a linked checkout) must be resolved first
    root: realpathSync(appDir),
    base: "./",
    configFile: false,
    envFile: false,
    logLevel: "warn",
    clearScreen: false,
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
      minify: "esbuild",
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: {
        output: {
          entryFileNames: "index.js",
          chunkFileNames: "chunks/[name].js",
          assetFileNames: (asset) =>
            (asset.names ?? []).some((name) => name.endsWith(".css")) ? "index.css" : "assets/[name][extname]",
          inlineDynamicImports: true,
        },
      },
    },
  });

  const entryFile = join(outDir, source.entry.path);
  const html = addIntegrity(readFileSync(entryFile, "utf8"), source.entry.path, (path) =>
    readFileSync(join(outDir, path)),
  );
  writeFileSync(entryFile, html);

  const files = listFiles(outDir);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const need = (path: string, from: string): BundleFile => {
    const file = byPath.get(path);
    if (!file) throw new Error(`${appDir}: ${from} names "${path}", which is not in the built bundle`);
    return file;
  };

  const entry = need(source.entry.path, "entry.path");
  const built = {
    ...source,
    entry: { path: source.entry.path, sha256: entry.sha256 },
    ...(source.assets
      ? {
          assets: source.assets.map((asset) => {
            const file = need(asset.path, `assets[${asset.name}].path`);
            return { name: asset.name, path: asset.path, sha256: file.sha256, bytes: file.bytes };
          }),
        }
      : {}),
    ...(source.store
      ? {
          store: {
            ...source.store,
            ...(source.store.screenshots
              ? {
                  screenshots: source.store.screenshots.map((shot) => ({
                    path: shot.path,
                    sha256: need(shot.path, "store.screenshots").sha256,
                    alt: shot.alt,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
  if (source.license.notices) need(source.license.notices, "license.notices");

  const result = validateAppManifest(built);
  if (!result.ok) {
    throw new Error(`${appDir}: the built manifest is not valid:\n${describe(result.issues)}`);
  }
  return {
    manifest: result.manifest,
    manifestSha256: manifestSha256(result.manifest),
    files,
    outDir,
  };
}
