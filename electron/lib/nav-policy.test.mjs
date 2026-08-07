import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { isAuthUrl } = require("./nav-policy.js");

/**
 * The allowlist that lets sign-in finish in-window.
 *
 * This is a security boundary, not a convenience: anything that returns true
 * here gets to render inside the shell window, wearing the native chrome that
 * makes the window look like pqp. A domain that should not be on this list is
 * a phishing page with the product's own frame around it.
 *
 * The failure this file exists to prevent is a suffix check written as a bare
 * `host.endsWith(suffix)`, which matches `evilgithub.com` against `github.com`.
 * It reads as correct and hands the window to anyone willing to register a
 * lookalike domain, so the deny cases below matter more than the allow ones.
 */

const APP = "https://pqp.gg";

describe("isAuthUrl", () => {
  it("allows the identity providers Clerk redirects to", () => {
    for (const url of [
      "https://accounts.google.com/o/oauth2/auth",
      "https://github.com/login/oauth/authorize",
      "https://appleid.apple.com/auth/authorize",
      "https://discord.com/oauth2/authorize",
      "https://login.microsoftonline.com/common/oauth2/authorize",
    ]) {
      assert.equal(isAuthUrl(url, APP), true, url);
    }
  });

  it("allows Clerk's hosts, including ones derived from the app domain", () => {
    for (const url of [
      "https://clerk.pqp.gg/v1/client",
      "https://accounts.pqp.gg/sign-in",
      "https://relaxed-cat-42.clerk.accounts.dev/v1/client",
    ]) {
      assert.equal(isAuthUrl(url, APP), true, url);
    }
  });

  it("refuses a lookalike domain that merely ends with an allowed host", () => {
    // Every one of these is registerable by anybody.
    for (const url of [
      "https://evilgithub.com/login",
      "https://evilaccounts.google.com/phish",
      "https://notdiscord.com/oauth2/authorize",
      "https://myappleid.apple.com/auth",
    ]) {
      assert.equal(isAuthUrl(url, APP), false, url);
    }
  });

  it("refuses an allowed host used as a prefix of somebody else's domain", () => {
    for (const url of [
      "https://github.com.attacker.example/login",
      "https://accounts.google.com.evil.test/o/oauth2",
    ]) {
      assert.equal(isAuthUrl(url, APP), false, url);
    }
  });

  it("refuses plain http, so a downgrade cannot carry a session", () => {
    assert.equal(isAuthUrl("http://accounts.google.com/o/oauth2/auth", APP), false);
    assert.equal(isAuthUrl("http://clerk.pqp.gg/v1/client", APP), false);
  });

  it("refuses anything unrelated, and anything unparseable", () => {
    assert.equal(isAuthUrl("https://attacker.example/evil", APP), false);
    assert.equal(isAuthUrl("not a url", APP), false);
    assert.equal(isAuthUrl("javascript:alert(1)", APP), false);
    assert.equal(isAuthUrl("file:///etc/passwd", APP), false);
  });

  it("does not derive Clerk hosts when there is no app origin", () => {
    assert.equal(isAuthUrl("https://clerk.pqp.gg/v1/client", null), false);
  });
});
