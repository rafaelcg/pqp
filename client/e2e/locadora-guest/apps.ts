import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll } from "../../../tools/apps-build/src/build.mts";
import { startDevServer } from "../../../tools/apps-build/src/dev-server.mts";

/**
 * The apps origin for this suite: the real packager's build of Locadora (the
 * same bytes the API's catalog names, which `pnpm apps:check` guarantees),
 * served the way the apps origin serves it, with one difference: the bundle's
 * `frame-ancestors` also lists this suite's client, which is on a port no real
 * deployment uses. Built into a temp folder and removed afterwards; nothing is
 * written into the repository.
 */
export interface AppsOrigin {
  origin: string;
  close(): Promise<void>;
}

export async function startAppsOrigin(port: number, clientOrigin: string): Promise<AppsOrigin> {
  const dist = mkdtempSync(join(tmpdir(), "pqp-locadora-guest-e2e-"));
  await buildAll({ outDir: dist, only: ["locadora"] });
  const headers = join(dist, "_headers");
  writeFileSync(
    headers,
    readFileSync(headers, "utf8").replaceAll("http://localhost:5173", `http://localhost:5173 ${clientOrigin}`),
  );
  const server: Server = await startDevServer(dist, port);
  return {
    origin: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(dist, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
