// Stages what npm will publish into `publish/` (git-ignored).
//
// WHY A STAGING FOLDER AND NOT package.json ITSELF. The package.json in this
// repo points `exports` at `src/index.ts`, so that the first-party apps, the
// dev server and `pnpm apps:check` keep bundling the TypeScript source exactly
// as they always did (the catalog hashes depend on those bytes), and it says
// `"private": true`, which is what keeps `npm publish` from working by
// accident. The package.json written here is the same package with the three
// differences a published package needs: it points at `dist/`, it is not
// private, and it carries no scripts and no devDependencies.
//
// Nothing is published by this script. `publish.mjs` does that, behind a guard.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "publish");
const repoRoot = join(root, "..", "..");

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("app-sdk: dist/ is missing. Run `pnpm --filter @pqp/app-sdk build` first.");
  process.exit(1);
}

const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The platform API this build speaks, read from the one line that sends it.
const connectSource = readFileSync(join(root, "src", "connect.ts"), "utf8");
const platformApi = Number(/^const PLATFORM_API = (\d+);/m.exec(connectSource)?.[1]);
if (!Number.isInteger(platformApi)) {
  console.error("app-sdk: could not read PLATFORM_API from src/connect.ts");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "dist"), join(out, "dist"), { recursive: true });
cpSync(join(root, "README.md"), join(out, "README.md"));
cpSync(join(root, "CHANGELOG.md"), join(out, "CHANGELOG.md"));
cpSync(join(repoRoot, "LICENSE"), join(out, "LICENSE"));

const published = {
  name: source.name,
  version: source.version,
  description: source.description,
  keywords: source.keywords,
  license: source.license,
  repository: source.repository,
  homepage: source.homepage,
  bugs: source.bugs,
  type: "module",
  sideEffects: false,
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
    "./package.json": "./package.json",
  },
  files: ["dist", "README.md", "CHANGELOG.md", "LICENSE"],
  // Not an npm field; it is how a tool (or a person with `npm view`) reads which
  // sandbox API this release speaks. The manifest's `platformApi` must match it.
  pqp: { platformApi },
  publishConfig: { access: "public" },
};

writeFileSync(join(out, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
console.log(`app-sdk: staged ${published.name}@${published.version} (platformApi ${platformApi}) in publish/`);
