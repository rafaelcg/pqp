// node --test tools/party-first-frame-bench/static-path.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveInside } from "./static-path.mjs";

const ROOT = "/srv/dist";

test("keeps ordinary paths inside the root", () => {
  assert.equal(resolveInside(ROOT, "/assets/app.js"), "/srv/dist/assets/app.js");
  assert.equal(resolveInside(ROOT, "/"), "/srv/dist");
});

test("refuses traversal, plain and encoded", () => {
  assert.equal(resolveInside(ROOT, "/../secret"), null);
  assert.equal(resolveInside(ROOT, "/%2e%2e%2f%2e%2e%2fhome/user/.ssh/id_rsa"), null);
  assert.equal(resolveInside(ROOT, "/assets/..%2f..%2fetc/passwd"), null);
});

test("refuses a sibling that merely shares the prefix, bad escapes and null bytes", () => {
  assert.equal(resolveInside(ROOT, "/../dist-secrets/x"), null);
  assert.equal(resolveInside(ROOT, "/%E0%A4%A"), null);
  assert.equal(resolveInside(ROOT, "/a%00b"), null);
});
