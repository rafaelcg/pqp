import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * A desktop release goes out as a GitHub PRE-RELEASE first and only becomes
 * the one installed apps update to after `electron-release-verify.yml` has run
 * the share smoke test against its published files (docs/DESKTOP.md §5,
 * "The release gate"). That only holds while the updater ignores
 * pre-releases. These pin the three things that make it ignore them.
 */

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
// The updater's own semver, so "a pre-release part" means what it means there.
const semver = createRequire(require.resolve("electron-updater"))("semver");

test("the app's version has no pre-release part, so electron-updater keeps allowPrerelease off", () => {
  // `AppUpdater` sets `allowPrerelease = hasPrereleaseComponents(version)`:
  // a `0.3.0-beta.1` build would follow every pre-release, unverified ones
  // included.
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(semver.prerelease(version), null, `version ${version} has a pre-release part`);
});

test("the shell never turns pre-releases or a channel on", () => {
  const source = readFileSync(path.join(root, "lib", "updater.js"), "utf8");
  assert.doesNotMatch(source, /allowPrerelease\s*=/);
  assert.doesNotMatch(source, /\.channel\s*=/);
});

test("with pre-releases off, the GitHub feed asks for /releases/latest, which skips a newer pre-release", async () => {
  const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
  const requested = [];
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><link rel="alternate" type="text/html" href="https://github.com/rafaelcg/pqp/releases/tag/v0.2.9"/><title>0.2.9 (pre-release)</title><content>new</content></entry>
  <entry><link rel="alternate" type="text/html" href="https://github.com/rafaelcg/pqp/releases/tag/v0.2.8"/><title>0.2.8</title><content>old</content></entry>
</feed>`;
  const executor = {
    async request(options) {
      const url = `${options.hostname ?? ""}${options.path}`;
      requested.push(url);
      if (options.path.endsWith("/releases.atom")) return atom;
      // GitHub's "latest" is the newest release that is neither a draft nor a
      // pre-release: 0.2.8 here.
      if (options.path.endsWith("/releases/latest")) return JSON.stringify({ tag_name: "v0.2.8" });
      if (options.path.endsWith("/latest.yml")) {
        return "version: 0.2.8\nfiles:\n  - url: pqp-0.2.8-x64.exe\n    sha512: X\n    size: 1\npath: pqp-0.2.8-x64.exe\nsha512: X\n";
      }
      throw new Error(`unexpected request ${url}`);
    },
  };
  const updater = {
    allowPrerelease: false,
    channel: null,
    currentVersion: semver.parse("0.2.7"),
    fullChangelog: false,
  };
  const provider = new GitHubProvider({ provider: "github", owner: "rafaelcg", repo: "pqp" }, updater, {
    isUseMultipleRangeRequest: false,
    platform: "win32",
    executor,
  });
  const info = await provider.getLatestVersion();
  assert.equal(info.version, "0.2.8");
  assert.ok(requested.some((u) => u.endsWith("/rafaelcg/pqp/releases/latest")), requested.join("\n"));
  assert.ok(requested.some((u) => u.includes("/download/v0.2.8/latest.yml")), requested.join("\n"));
  assert.ok(!requested.some((u) => u.includes("v0.2.9")), "the pre-release was fetched");
});
