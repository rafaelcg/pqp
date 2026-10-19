import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { build } from "vite";

const CLIENT = path.resolve(import.meta.dirname, "../..");
const SDK = path.resolve(CLIENT, "../packages/app-sdk/src/index.ts");

async function bundle(entry: string, outDir: string, name: string) {
  await build({
    root: CLIENT,
    configFile: false,
    envFile: false,
    logLevel: "error",
    resolve: { alias: { "@pqp/app-sdk": SDK, "@": path.join(CLIENT, "src") } },
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: "es2022",
      write: true,
      lib: { entry, formats: ["es"], fileName: () => `${name}.js` },
    },
  });
}

/**
 * Builds what the specs serve into `outDir`:
 *
 * - `host/page.js`: the real controller, bridge host and policy plus the fake
 *   transport (`harness-page.ts`);
 * - `apps/coop/1.0.0/`: a cooperative app on the real SDK (`frames/coop.ts`);
 * - `apps/hostile/1.0.0/`: a hand-written hostile page (`frames/hostile.js`).
 */
export async function buildAppFrameFixtures(outDir: string): Promise<void> {
  const here = import.meta.dirname;
  mkdirSync(path.join(outDir, "host"), { recursive: true });
  mkdirSync(path.join(outDir, "apps/coop/1.0.0"), { recursive: true });
  mkdirSync(path.join(outDir, "apps/hostile/1.0.0"), { recursive: true });
  await bundle(path.join(here, "harness-page.ts"), path.join(outDir, "host"), "page");
  await bundle(path.join(here, "frames/coop.ts"), path.join(outDir, "apps/coop/1.0.0"), "coop");
  copyFileSync(path.join(here, "frames/coop.html"), path.join(outDir, "apps/coop/1.0.0/index.html"));
  copyFileSync(path.join(here, "frames/hostile.html"), path.join(outDir, "apps/hostile/1.0.0/index.html"));
  copyFileSync(path.join(here, "frames/hostile.js"), path.join(outDir, "apps/hostile/1.0.0/hostile.js"));
}
