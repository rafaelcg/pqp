// Fails when `publish/` would ship something a consumer cannot use. It checks
// the staged folder, not the source, because the staged folder is what npm gets.
//
//   1. The manifest is publishable: not private, no scripts, no dependencies.
//   2. Nothing in dist/ names a package: every import is a relative file that
//      exists. In particular no `@pqp/shared` and no `zod` (the type leak that
//      would make `import ... from "@pqp/app-sdk"` fail to type-check).
//   3. The package loads, and exports what the docs promise.
//   4. A strict consumer (skipLibCheck off) type-checks the quickstart against
//      the staged package, with only `lib.dom` available, as an app has.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "publish");
const problems = [];
const fail = (message) => problems.push(message);

if (!existsSync(join(pkgDir, "package.json"))) {
  console.error("app-sdk: publish/ is missing. Run `pnpm --filter @pqp/app-sdk package`.");
  process.exit(1);
}

// 1. the manifest
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
if (pkg.private) fail("publish/package.json is private");
for (const key of ["scripts", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  if (pkg[key] !== undefined) fail(`publish/package.json has ${key}`);
}
if (!pkg.license) fail("publish/package.json has no license");
for (const target of [pkg.main, pkg.types, pkg.exports?.["."]?.types, pkg.exports?.["."]?.import]) {
  if (!target || !existsSync(join(pkgDir, target))) fail(`package.json points at ${target}, which is not staged`);
}
for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) {
  if (!existsSync(join(pkgDir, file))) fail(`${file} is not staged`);
}
if (pkg.pqp?.platformApi !== 1) fail(`pqp.platformApi is ${pkg.pqp?.platformApi}, the docs say 1`);

// 2. nothing in dist/ names a package
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
const files = walk(join(pkgDir, "dist"));
for (const file of files) {
  if (file.endsWith(".test.js") || file.endsWith(".test.d.ts") || file.includes("fixture")) {
    fail(`${file.slice(pkgDir.length + 1)} is a test file in the tarball`);
  }
  if (!/\.(js|d\.ts)$/.test(file)) fail(`unexpected file ${file.slice(pkgDir.length + 1)} in dist/`);
  // comments out first: the header of index.ts quotes an import as an example
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    if (!spec.startsWith("./")) {
      fail(`${file.slice(pkgDir.length + 1)} imports "${spec}"; a published file may import only its own files`);
    } else if (!existsSync(resolve(dirname(file), spec.replace(/\.js$/, file.endsWith(".d.ts") ? ".d.ts" : ".js")))) {
      fail(`${file.slice(pkgDir.length + 1)} imports ${spec}, which is not in the tarball`);
    }
  }
  if (/@pqp\/|\bzod\b/.test(text)) {
    fail(`${file.slice(pkgDir.length + 1)} mentions @pqp/ or zod outside a comment`);
  }
}

// 3. it loads and exports what the docs say
const expected = ["PortClient", "PqpAppError", "REQUEST_TIMEOUT_MS", "applyTheme", "connect", "createApp"];
const loaded = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);
const got = Object.keys(loaded).sort();
if (JSON.stringify(got) !== JSON.stringify(expected)) {
  fail(`runtime exports are ${got.join(", ")}; expected ${expected.join(", ")}. Update docs-apps/sdk if this is on purpose`);
}

// 4. a strict consumer
const scratch = mkdtempSync(join(tmpdir(), "pqp-sdk-consumer-"));
try {
  mkdirSync(join(scratch, "node_modules", "@pqp"), { recursive: true });
  symlinkSync(pkgDir, join(scratch, "node_modules", "@pqp", "app-sdk"), "dir");
  writeFileSync(
    join(scratch, "consumer.ts"),
    `import {
  applyTheme,
  connect,
  PqpAppError,
  type BridgeErrorCode,
  type JsonValue,
  type Participant,
  type PqpApp,
} from "@pqp/app-sdk";

async function main(): Promise<void> {
  const app: PqpApp = await connect();
  applyTheme(app.hello.theme);
  app.on("theme", (theme) => applyTheme(theme));
  app.on("ended", (reason) => console.log(reason.toUpperCase()));
  const render = (people: Participant[]) => console.log(people.map((p) => p.displayName));
  app.participants.on(render);
  render(await app.participants.get());
  const { rev, value } = await app.state.get();
  const next: JsonValue = { count: typeof value === "object" && value !== null && !Array.isArray(value) ? 1 : 0 };
  try {
    await app.state.patch(next, { baseRev: rev });
  } catch (error) {
    const code: BridgeErrorCode | undefined = error instanceof PqpAppError ? error.code : undefined;
    if (code !== "stale-rev") throw error;
  }
  await app.events.send("ping", { hello: true });
}
void main();
`,
  );
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ["consumer.ts"],
    }),
  );
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tsc, "-p", scratch], { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    fail(`a strict consumer does not type-check against the staged package:\n${error.stdout ?? error.message}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`app-sdk: publish/ is not ready:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`app-sdk: publish/ is ready (${files.length} files in dist/, ${pkg.name}@${pkg.version})`);
