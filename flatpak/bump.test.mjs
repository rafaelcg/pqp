import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { addRelease, bumpManifest, debUrl, licenseUrl } from "./bump.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = readFileSync(path.join(here, "gg.pqp.pqp.yml"), "utf8");
const metainfo = readFileSync(path.join(here, "gg.pqp.pqp.metainfo.xml"), "utf8");

const DEB = "a".repeat(64);
const LIC = "b".repeat(64);

describe("bumpManifest", () => {
  const out = bumpManifest(manifest, { version: "0.3.0", debSha256: DEB, licenseSha256: LIC });

  it("points the .deb source at the release and pins its hash", () => {
    assert.match(out, new RegExp(`url: ${debUrl("0.3.0").replace(/\./g, "\\.")}\\n\\s+sha256: ${DEB}`));
  });

  it("pins the LICENSE to the same tag", () => {
    assert.match(out, new RegExp(`url: ${licenseUrl("0.3.0").replace(/\./g, "\\.")}\\n\\s+sha256: ${LIC}`));
  });

  it("leaves nothing pointing at the old release", () => {
    assert.ok(!/v0\.2\.4/.test(out));
  });

  it("keeps the comments and the checker block", () => {
    assert.ok(out.includes("x-checker-data:"));
    assert.ok(out.includes("# Flathub manifest for the pqp desktop app."));
    assert.equal(out.split("\n").length, manifest.split("\n").length);
  });

  it("refuses a malformed version or hash", () => {
    assert.throws(() => bumpManifest(manifest, { version: "v0.3.0", debSha256: DEB, licenseSha256: LIC }));
    assert.throws(() => bumpManifest(manifest, { version: "0.3.0", debSha256: "xyz", licenseSha256: LIC }));
  });

  it("refuses a manifest it cannot find the sources in", () => {
    assert.throws(() => bumpManifest("id: x\n", { version: "0.3.0", debSha256: DEB, licenseSha256: LIC }));
  });
});

describe("addRelease", () => {
  it("puts the new release first", () => {
    const out = addRelease(metainfo, { version: "0.3.0", date: "2026-10-20" });
    const first = out.indexOf("<release ");
    assert.equal(out.indexOf('<release version="0.3.0" date="2026-10-20">'), first);
    assert.ok(out.includes("https://github.com/rafaelcg/pqp/releases/tag/v0.3.0"));
  });

  it("does nothing when the version is already listed", () => {
    assert.equal(addRelease(metainfo, { version: "0.2.4", date: "2026-10-05" }), metainfo);
  });

  it("escapes a summary", () => {
    const out = addRelease(metainfo, { version: "0.3.0", date: "2026-10-20", summary: "a < b & c" });
    assert.ok(out.includes("<p>a &lt; b &amp; c</p>"));
  });

  it("refuses a bad date", () => {
    assert.throws(() => addRelease(metainfo, { version: "0.3.0", date: "20 Oct" }));
  });
});
