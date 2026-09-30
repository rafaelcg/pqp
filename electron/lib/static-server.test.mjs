import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { LOCAL_CSP, cspForHtml, inlineScriptHashes } = require("./static-server.js");

const hash = (body) =>
  `'sha256-${createHash("sha256").update(body).digest("base64")}'`;

describe("inlineScriptHashes", () => {
  it("hashes the exact bytes of every inline classic script", () => {
    const a = "\n  window.a = 1;\n";
    const b = "(function(){})();";
    const html = `<head><script>${a}</script><script>${b}</script></head>`;
    assert.deepEqual(inlineScriptHashes(html), [hash(a), hash(b)]);
  });

  it("skips scripts with a src, which 'self' already covers", () => {
    const html = '<script type="module" crossorigin src="/assets/index.js"></script>';
    assert.deepEqual(inlineScriptHashes(html), []);
  });

  it("skips data blocks that never execute", () => {
    const html = '<script type="application/ld+json">{"@context":"x"}</script>';
    assert.deepEqual(inlineScriptHashes(html), []);
  });

  it("changes when a single byte of a script changes", () => {
    assert.notDeepEqual(
      inlineScriptHashes("<script>a()</script>"),
      inlineScriptHashes("<script>a() </script>"),
    );
  });
});

describe("cspForHtml", () => {
  it("adds the hashes to script-src and leaves everything else alone", () => {
    const body = "boot();";
    const csp = cspForHtml(`<script>${body}</script>`);
    assert.ok(csp.includes(`script-src 'self' ${hash(body)}`));
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(!csp.includes("'unsafe-inline' 'sha256"), "no blanket inline allowance");
    assert.ok(csp.includes("object-src 'none'"));
  });

  it("is the strict base policy for a page with no inline script", () => {
    assert.equal(cspForHtml("<html></html>"), LOCAL_CSP);
  });
});
