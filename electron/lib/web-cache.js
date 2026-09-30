const fs = require("node:fs");
const path = require("node:path");

/**
 * The web half of the desktop app's state, and when to throw it away.
 *
 * A packaged build loads the hosted client (`https://pqp.gg/app`), so what the
 * window runs is whatever the site's service worker and Chromium's HTTP cache
 * hand it, and both live in the profile under `userData`, across restarts and
 * across shell updates. A shell that updates around a profile holding an older
 * copy of the site is exactly how a Windows PC ran the new shell and the old
 * website on 2026-09-30 (see `docs/PWA.md`, "Nobody stays on an old bundle").
 *
 * WHAT IS CLEARED: the HTTP cache, and the `serviceworkers` and `cachestorage`
 * storages, which is the worker and its precache. NOT cookies, `localStorage`,
 * IndexedDB or anything else: the person stays signed in and keeps their
 * drafts. A push subscription dies with the worker registration, but the desktop
 * shell does not use Web Push (it raises notifications itself), so nothing is
 * lost that the shell had.
 */

const VERSION_FILE = "shell-version.json";
const STORAGES = ["serviceworkers", "cachestorage"];

function versionPath(userDataPath) {
  return path.join(userDataPath, VERSION_FILE);
}

/** The shell version last run against this profile, or null if none is recorded. */
function readRecordedVersion(userDataPath, fileSystem = fs) {
  try {
    const parsed = JSON.parse(
      fileSystem.readFileSync(versionPath(userDataPath), "utf8"),
    );
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function recordVersion(userDataPath, version, fileSystem = fs) {
  try {
    fileSystem.writeFileSync(
      versionPath(userDataPath),
      JSON.stringify({ version }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the cached site: the HTTP cache and the service worker with its
 * precache. The page that loads next is fetched from the network.
 *
 * @param {{ clearCache: () => Promise<void>, clearStorageData: (options: object) => Promise<void> }} ses
 */
async function clearWebCache(ses) {
  await ses.clearCache();
  await ses.clearStorageData({ storages: STORAGES });
}

/**
 * Clear the cached site the first time a NEW shell version runs against a
 * profile. Returns what it did:
 *  - `"same"`: this version already ran here, nothing touched;
 *  - `"cleared"`: a different (or no recorded) version: cleared and recorded;
 *  - `"failed"`: the clear threw. NOT recorded, so the next launch tries again,
 *    and never fatal: a shell that cannot clear its cache must still start.
 *
 * A profile with no record counts as new: it is either a fresh install (an empty
 * cache, so the clear is free) or one from a shell that predates this file,
 * which is precisely the profile that may be holding a stale site.
 */
async function clearWebCacheIfShellUpdated({
  userDataPath,
  version,
  session: ses,
  fileSystem = fs,
  log = () => {},
}) {
  if (readRecordedVersion(userDataPath, fileSystem) === version) {
    return "same";
  }
  try {
    await clearWebCache(ses);
  } catch (err) {
    log("could not clear the cached site:", err?.message ?? err);
    return "failed";
  }
  recordVersion(userDataPath, version, fileSystem);
  return "cleared";
}

module.exports = {
  VERSION_FILE,
  STORAGES,
  readRecordedVersion,
  recordVersion,
  clearWebCache,
  clearWebCacheIfShellUpdated,
};
