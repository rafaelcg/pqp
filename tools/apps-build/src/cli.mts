import { mkdtempSync, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { REPO_ROOT, buildAll, catalogFile, checkImmutability, committedCatalog } from "./build.mts";
import { CATALOG_PATH } from "./catalog.mts";
import { startDevServer } from "./dev-server.mts";

const DIST = join(REPO_ROOT, "dist-apps");
const DEV_PORT = Number(process.env.APPS_DEV_PORT ?? 5175);

function fail(message: string): never {
  console.error(`apps: ${message}`);
  process.exit(1);
}

function firstDifference(a: string, b: string): string {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) {
      return `first difference at line ${i + 1}:\n  committed: ${left[i] ?? "(end of file)"}\n  built:     ${right[i] ?? "(end of file)"}`;
    }
  }
  return "no difference";
}

async function build() {
  const result = await buildAll({ outDir: DIST });
  const outcome = checkImmutability(REPO_ROOT, result.catalog, process.env.CI === "true");
  if (outcome.violations.length > 0) fail(outcome.violations.join("\n"));
  if (outcome.note) console.warn(`apps: ${outcome.note}`);
  mkdirSync(join(REPO_ROOT, "server/src/apps"), { recursive: true });
  writeFileSync(catalogFile(REPO_ROOT), result.catalogText);
  for (const app of result.apps) {
    console.log(`apps: built ${app.manifest.id}@${app.manifest.version} (${app.files.length} files, manifestSha256 ${app.manifestSha256.slice(0, 12)})`);
  }
  console.log(`apps: wrote ${CATALOG_PATH} and ${relative(REPO_ROOT, DIST)}/`);
}

async function check() {
  const scratch = mkdtempSync(join(tmpdir(), "pqp-apps-check-"));
  try {
    const result = await buildAll({ outDir: scratch });
    const committed = committedCatalog(REPO_ROOT);
    if (committed === null) {
      fail(`${CATALOG_PATH} is missing. Run pnpm apps:build and commit it.`);
    }
    if (committed !== result.catalogText) {
      fail(
        `${CATALOG_PATH} is stale. Run pnpm apps:build and commit the result (a changed app or SDK file changes the bundle hash: bump the app's version if it is already released).\n${firstDifference(committed, result.catalogText)}`,
      );
    }
    const outcome = checkImmutability(REPO_ROOT, result.catalog, process.env.CI === "true");
    if (outcome.violations.length > 0) fail(outcome.violations.join("\n"));
    if (outcome.note) console.warn(`apps: ${outcome.note}`);
    console.log(`apps: ${CATALOG_PATH} is up to date (${result.apps.length} app${result.apps.length === 1 ? "" : "s"})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function dev() {
  const rebuild = async () => {
    try {
      const result = await buildAll({ outDir: DIST });
      console.log(`apps: rebuilt ${result.apps.map((a) => `${a.manifest.id}@${a.manifest.version}`).join(", ")}`);
    } catch (error) {
      console.error(`apps: build failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await rebuild();
  await startDevServer(DIST, DEV_PORT);
  console.log(`apps: serving ${relative(REPO_ROOT, DIST)}/ on http://localhost:${DEV_PORT}`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 250);
  };
  for (const dir of ["apps", "packages/app-sdk/src"]) {
    watch(join(REPO_ROOT, dir), { recursive: true }, (_event, name) => {
      if (name && /(^|[\\/])(node_modules|dist)([\\/]|$)/.test(name)) return;
      schedule();
    });
  }
}

const command = process.argv[2];
if (command === "build") await build();
else if (command === "check") await check();
else if (command === "dev") await dev();
else fail(`usage: cli.mts <build|check|dev> (got "${command ?? ""}")`);
