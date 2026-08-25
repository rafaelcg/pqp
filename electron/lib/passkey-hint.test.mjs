import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { mayPromptForPasskey, PASSKEY_HINT_DELAY_MS } = require("./passkey-hint.js");

/**
 * Which pages get the "Try another way" hint.
 *
 * This is a cosmetic decision, not a security boundary: a wrong answer
 * mistitles a window, it does not grant anything trust. It is tested to the
 * same standard anyway, because the host-matching mistake it could make
 * (`endsWith` instead of an exact match) is the same one that would be a
 * phishing hole in nav-policy.js, and the habit is worth more than this file.
 */
describe("mayPromptForPasskey", () => {
  it("matches the Google sign-in host", () => {
    assert.equal(mayPromptForPasskey("https://accounts.google.com/"), true);
  });

  it("matches whatever challenge path Google is using this month", () => {
    // The paths move. That is exactly why this is matched on host alone.
    for (const path of [
      "/signin/v2/challenge/pwd",
      "/v3/signin/challenge/pk/presend",
      "/signin/challenge/pk/webauthn",
      "/o/oauth2/v2/auth?client_id=x",
    ]) {
      assert.equal(
        mayPromptForPasskey(`https://accounts.google.com${path}`),
        true,
        path,
      );
    }
  });

  it("does not match a lookalike host", () => {
    // The failure this guards: `host.endsWith("accounts.google.com")`.
    assert.equal(mayPromptForPasskey("https://evilaccounts.google.com/"), false);
    assert.equal(mayPromptForPasskey("https://accounts.google.com.evil.tld/"), false);
    assert.equal(mayPromptForPasskey("https://notaccounts.google.com/"), false);
  });

  it("does not match other identity providers", () => {
    // Apple runs its own ceremony and is not known to hang the same way; if it
    // turns out to, add the host rather than loosening the match.
    assert.equal(mayPromptForPasskey("https://appleid.apple.com/auth"), false);
    assert.equal(mayPromptForPasskey("https://github.com/login"), false);
    assert.equal(mayPromptForPasskey("https://clerk.pqp.gg/v1/oauth_callback"), false);
  });

  it("does not match the app's own pages", () => {
    assert.equal(mayPromptForPasskey("https://pqp.gg/app"), false);
  });

  it("ignores plaintext and junk", () => {
    assert.equal(mayPromptForPasskey("http://accounts.google.com/"), false);
    assert.equal(mayPromptForPasskey("not a url"), false);
    assert.equal(mayPromptForPasskey(""), false);
  });

  it("is case-insensitive about the host", () => {
    assert.equal(mayPromptForPasskey("https://ACCOUNTS.GOOGLE.COM/signin"), true);
  });
});

describe("PASSKEY_HINT_DELAY_MS", () => {
  it("waits long enough not to interrupt someone typing a password", () => {
    // The hint is unsolicited. Firing it at 5s would land on top of every
    // ordinary sign-in; the point is to catch a spinner that never resolves.
    assert.ok(PASSKEY_HINT_DELAY_MS >= 15_000, "too eager to interrupt");
    assert.ok(PASSKEY_HINT_DELAY_MS <= 45_000, "too slow to be useful");
  });
});
