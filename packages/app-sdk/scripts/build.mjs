// Builds `dist/`: ES2022 modules and `.d.ts` files, one per source file, with
// `tsc` and nothing else. There is no bundler on purpose: the SDK has no
// dependencies, so there is nothing to bundle, and the emitted `.js` is the
// source with its types removed (an app's own bundler does the rest).
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

rmSync(join(root, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
console.log("app-sdk: built dist/");
