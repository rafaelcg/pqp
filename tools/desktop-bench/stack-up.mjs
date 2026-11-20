// Bring the bench stack up and leave it running, for the profile and retention
// scripts and for poking at a scene by hand. Prints the environment those
// scripts read as JSON on stdout (logs go to stderr), then waits for Ctrl-C and
// tears everything down, including the scratch database.
//
//   node tools/desktop-bench/stack-up.mjs [--client-dist DIR] [--pg-admin URL]
//   # in another shell, export the printed BENCH_* values, then run a script
import os from "node:os";
import path from "node:path";
import { ensureClientBuild, startStack } from "./lib/stack.mjs";

const argv = process.argv.slice(2);
const val = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const log = (m) => console.error(`[stack-up] ${m}`);
const clientDist = val("client-dist", path.join(os.tmpdir(), "pqp-desktop-bench-client-dist"));
if (!argv.includes("--client-dist")) ensureClientBuild({ outDir: clientDist, log });

const stack = await startStack({
  pgAdminUrl: val("pg-admin", process.env.BENCH_PG_ADMIN_URL ?? "postgres://postgres:bench@127.0.0.1:55439/postgres"),
  clientDist,
  log,
});
console.log(
  JSON.stringify({
    BENCH_APP_URL: stack.appUrl,
    BENCH_SERVER_ID: stack.ids.serverId,
    BENCH_LIGHT_CHANNEL: stack.ids.lightChannelId,
    BENCH_HEAVY_CHANNEL: stack.ids.heavyChannelId,
    BENCH_VOICE_CHANNEL: stack.ids.voiceChannelId,
    BENCH_PARTY_CHANNEL: stack.ids.partyChannelId,
  }),
);
const down = async () => {
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", down);
process.on("SIGTERM", down);
await new Promise(() => {});
