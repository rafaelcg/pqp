"use strict";

/**
 * electron-builder `afterAllArtifactBuild` hook — notarize and staple the
 * macOS **disk images**.
 *
 * Why this exists
 * ---------------
 * electron-builder's `mac.notarize` option notarizes and staples the `.app`
 * bundle, and nothing else. It does that inside `signApp`, i.e. *before* the
 * dmg/zip targets run. The dmg target then wraps the already-stapled `.app`
 * into a disk image and stops: it never submits the dmg to Apple and it never
 * staples it. (`dmg-builder`'s only signing code is `signDmg`, gated on
 * `dmg.sign`, which defaults to false; grep app-builder-lib for "staple" and
 * you get zero hits.)
 *
 * The result is exactly what shipped from run 31183972324: a correct `.app`
 * inside a `.dmg` that Gatekeeper rejects with "source=no usable signature",
 * because the dmg is the file the user actually downloads and it carries
 * neither a signature nor a ticket of its own.
 *
 * Apple's rule is to notarize the artifact you distribute. So:
 *
 *   1. `dmg.sign: true` (electron/package.json) codesigns the dmg when the dmg
 *      target builds it — before this hook runs, which is the required order:
 *      sign → notarize → staple.
 *   2. This hook submits each dmg to notarytool and staples the returned
 *      ticket onto it.
 *
 * The `.zip` deliberately gets neither. `stapler` cannot write a ticket into a
 * zip archive — there is nowhere to put it — and it does not need one:
 *   - Squirrel.Mac (what electron-updater drives on macOS) validates the
 *     downloaded bundle's *code signature* against the running app's
 *     designated requirement. That is a signature check, not a notarization
 *     check, and it is satisfied by the Developer ID signature already on the
 *     app.
 *   - electron-updater fetches the zip over Node's HTTP stack, so the file
 *     never receives a `com.apple.quarantine` xattr and Gatekeeper never runs
 *     a first-launch assessment on the staged app.
 *   - If a human downloads the zip from the release page instead, the browser
 *     *does* set quarantine — and the `.app` inside was notarized and stapled
 *     by electron-builder, so that path validates offline too.
 *
 * Cost: one extra Apple round trip (~90s). The two dmgs are submitted
 * concurrently, so this adds one round trip of wall clock, not two.
 *
 * Failure mode: this throws. An unnotarized dmg must fail the build loudly
 * rather than be uploaded as a release asset that macOS calls "damaged".
 * The one silent path is "no credentials at all", which is the fork case —
 * see the gate in `resolveCredentials`.
 */

const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * Run an `xcrun` subcommand without ever echoing the argv, which on the
 * notarytool path contains the App Store Connect key id / issuer (and, on the
 * Apple ID fallback, an app-specific password). Node puts the full command
 * line into `error.message`, so failures are re-thrown with a sanitized one.
 */
async function xcrun(args, { label }) {
  try {
    const { stdout, stderr } = await execFileAsync("xcrun", args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}`.trim();
    throw new Error(
      `${label} failed (exit ${error.code ?? "?"})${output ? `\n${output}` : ""}`,
    );
  }
}

/**
 * Which notarytool authentication is available.
 *
 * There is intentionally no APPLE_TEAM_ID handling on the API-key path.
 * notarytool resolves the team from the App Store Connect issuer that owns the
 * key, so `--team-id` is not required there (and this account has one team,
 * WXBFUF9WMA, so there is nothing to disambiguate). `--team-id` is only
 * *required* on the Apple ID fallback, which this repo has no secrets for —
 * which is why there is no APPLE_TEAM_ID secret and nothing hardcoded here.
 *
 * These are the same env vars electron-builder itself reads for `mac.notarize`,
 * so the app and the dmg can never disagree about whether to notarize.
 */
function resolveCredentials(env) {
  const {
    APPLE_API_KEY,
    APPLE_API_KEY_ID,
    APPLE_API_ISSUER,
    APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID,
  } = env;

  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return {
      kind: "App Store Connect API key",
      args: [
        "--key",
        APPLE_API_KEY,
        "--key-id",
        APPLE_API_KEY_ID,
        "--issuer",
        APPLE_API_ISSUER,
      ],
    };
  }

  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    return {
      kind: "Apple ID app-specific password",
      args: [
        "--apple-id",
        APPLE_ID,
        "--password",
        APPLE_APP_SPECIFIC_PASSWORD,
        "--team-id",
        APPLE_TEAM_ID,
      ],
    };
  }

  return null;
}

/**
 * `notarytool --output-format json` emits one JSON object, but whether it is
 * compact or pretty-printed has changed between Xcode releases and it can be
 * preceded by progress lines. Take the last balanced `{...}` in the output.
 */
function parseSubmissionResult(raw) {
  const candidates = [raw.trim()];
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function notarizeAndStaple(dmgPath, credentialArgs) {
  const name = path.basename(dmgPath);
  const startedAt = Date.now();

  console.log(`  • notarizing dmg  file=${name}`);

  const raw = await xcrun(
    [
      "notarytool",
      "submit",
      dmgPath,
      ...credentialArgs,
      "--wait",
      // A submission that hangs must fail the job, not sit there until the
      // 60-minute job timeout kills it with no diagnostic.
      "--timeout",
      "20m",
      "--output-format",
      "json",
    ],
    { label: `notarytool submit ${name}` },
  );

  // `notarytool submit --wait` exits 0 for a submission that came back
  // Invalid on some Xcode versions, so the status is checked explicitly
  // rather than trusted to the exit code.
  const result = parseSubmissionResult(raw);
  if (result == null) {
    throw new Error(`notarytool submit ${name}: unparseable output\n${raw}`);
  }

  if (result.status !== "Accepted") {
    let log = "";
    if (result.id) {
      log = await xcrun(
        ["notarytool", "log", result.id, ...credentialArgs],
        { label: `notarytool log ${result.id}` },
      ).catch((error) => `(could not fetch log: ${error.message})`);
    }
    throw new Error(
      `Notarization of ${name} returned status=${result.status} ` +
        `(id=${result.id ?? "unknown"}): ${result.message ?? "no message"}\n${log}`,
    );
  }

  await xcrun(["stapler", "staple", dmgPath], { label: `stapler staple ${name}` });
  await xcrun(["stapler", "validate", dmgPath], {
    label: `stapler validate ${name}`,
  });

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`  • dmg notarized and stapled  file=${name} took=${seconds}s`);
}

module.exports = async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== "darwin") {
    return [];
  }

  const dmgs = (buildResult.artifactPaths || []).filter((artifact) =>
    artifact.endsWith(".dmg"),
  );
  if (dmgs.length === 0) {
    return [];
  }

  const credentials = resolveCredentials(process.env);
  if (credentials == null) {
    // Fork / no-secrets case. electron-builder has already warned that the
    // build is unsigned or unnotarized; do not turn that into a red X.
    console.log(
      "::warning::Skipping dmg notarization — no Apple credentials in the " +
        "environment. The .dmg will be rejected by Gatekeeper.",
    );
    return [];
  }

  console.log(
    `  • notarizing ${dmgs.length} dmg(s) with ${credentials.kind} ` +
      "(concurrent — one round trip of wall clock, not one per artifact)",
  );

  // Concurrent on purpose: serial submission would add ~90s per architecture.
  await Promise.all(dmgs.map((dmg) => notarizeAndStaple(dmg, credentials.args)));

  // No new artifacts — the dmgs were modified in place.
  return [];
};
