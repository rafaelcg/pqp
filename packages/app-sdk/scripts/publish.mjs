// Publishes the staged package to npm. Run it through `pnpm --filter @pqp/app-sdk
// publish:npm`, which builds, stages and checks first. See PUBLISHING.md.
//
// It refuses to do anything unless you say you mean it, so that a stray
// `pnpm run publish:npm` (or a script that runs every package's scripts) cannot
// put a package on the public registry. Say you mean it with:
//
//   PQP_SDK_PUBLISH=yes pnpm --filter @pqp/app-sdk publish:npm
//
// Add NPM_OTP=123456 when the account has two-factor authentication on writes.
// A release made from a laptop has no provenance statement; the GitHub workflow
// (.github/workflows/release-app-sdk.yml) is the way to get one.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "publish", "package.json"), "utf8"));
const spec = `${pkg.name}@${pkg.version}`;

if (process.env.PQP_SDK_PUBLISH !== "yes") {
  console.error(
    `app-sdk: not publishing ${spec}. This puts a package on the public npm registry and cannot be undone.\n` +
      "Set PQP_SDK_PUBLISH=yes to go ahead (PUBLISHING.md has the steps and the checklist).",
  );
  process.exit(1);
}

// npm refuses to republish a version, but say it before the upload, not after.
let published = false;
try {
  execFileSync("npm", ["view", spec, "version"], { stdio: "pipe" });
  published = true;
} catch {
  // a 404 is the expected answer for a new version
}
if (published) {
  console.error(`app-sdk: ${spec} is already on npm. Bump "version" in package.json and CHANGELOG.md.`);
  process.exit(1);
}

const args = ["publish", join(root, "publish"), "--access", "public"];
if (process.env.NPM_OTP) args.push("--otp", process.env.NPM_OTP);
execFileSync("npm", args, { stdio: "inherit" });
console.log(`app-sdk: published ${spec}`);
