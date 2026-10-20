import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateAppManifest } from "@pqp/shared";
import { REPO_ROOT, buildAll } from "./build.mts";
import { buildApp } from "./bundle.mts";
import { parseHeaders, headersFor } from "./headers.mts";
import { sha256Hex } from "./hash.mts";

const scratch: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const ecoSource = JSON.parse(readFileSync(join(REPO_ROOT, "apps/eco/manifest.source.json"), "utf8"));

/** A throwaway app folder: its own manifest source, a page, a script, optional extras. */
function fixtureApp(
  id: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
): string {
  const dir = temp(`pqp-fixture-${id}-`);
  const root = join(dir, id);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "manifest.source.json"),
    JSON.stringify({ ...ecoSource, id, ...manifest }),
  );
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body><script type="module" src="./main.js"></script></body></html>';

describe("a real build of the apps in the repository", () => {
  it("is deterministic: two builds give the same files, hashes, headers and catalog", async () => {
    const [a, b] = [temp("pqp-det-a-"), temp("pqp-det-b-")];
    const first = await buildAll({ outDir: a });
    const second = await buildAll({ outDir: b });
    expect(second.catalogText).toBe(first.catalogText);
    expect(second.headers).toBe(first.headers);
    expect(second.apps.map((app) => app.files)).toEqual(first.apps.map((app) => app.files));
    expect(first.apps.length).toBeGreaterThan(0);
  });

  it("writes Eco with SRI that matches its files, a filled manifest and a CSP header rule", async () => {
    const out = temp("pqp-eco-");
    const result = await buildAll({ outDir: out });
    const eco = result.apps.find((app) => app.manifest.id === "pqp-eco")!;
    const dir = join(out, "pqp-eco", eco.manifest.version);

    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(eco.manifest.entry.sha256).toBe(sha256Hex(readFileSync(join(dir, "index.html"))));
    const tags = [...html.matchAll(/<(?:script|link)\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBe(2);
    for (const tag of tags) {
      const ref = /(?:src|href)="\.\/([^"]+)"/.exec(tag)![1]!;
      const integrity = /integrity="(sha384-[^"]+)"/.exec(tag)?.[1];
      expect(integrity, tag).toBeDefined();
      expect(integrity).toBe(`sha384-${createHash("sha384").update(readFileSync(join(dir, ref))).digest("base64")}`);
      expect(tag).toContain("crossorigin");
    }
    // nothing the frame's CSP would refuse
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/\sstyle=/);

    expect(validateAppManifest(eco.manifest).ok).toBe(true);
    const rule = headersFor(parseHeaders(result.headers), `/pqp-eco/${eco.manifest.version}/index.html`);
    expect(rule.get("content-security-policy")).toContain("default-src 'none'");
    expect(rule.get("cache-control")).toContain("immutable");
  });

  it("does not ship the SDK's or zod's dependencies: the bundle stays small and has no zod", async () => {
    const out = temp("pqp-size-");
    const result = await buildAll({ outDir: out });
    const eco = result.apps.find((app) => app.manifest.id === "pqp-eco")!;
    const js = eco.files.find((file) => file.path === "index.js")!;
    expect(js.bytes).toBeLessThan(40_000);
    const text = readFileSync(join(out, "pqp-eco", eco.manifest.version, "index.js"), "utf8");
    expect(text).not.toContain("ZodError");
  });
});

describe("buildApp on fixtures", () => {
  it("fills assets[] with the sha256 and size of the built file", async () => {
    const root = fixtureApp(
      "pqp-fixture-assets",
      { "index.html": PAGE, "main.js": "console.log(1)", "public/core.bin": "0123456789" },
      { assets: [{ name: "core.bin", path: "core.bin" }] },
    );
    const built = await buildApp(root, temp("pqp-out-"));
    expect(built.manifest.assets).toEqual([
      { name: "core.bin", path: "core.bin", sha256: sha256Hex("0123456789"), bytes: 10 },
    ]);
  });

  it("refuses an asset that is not in the bundle", async () => {
    const root = fixtureApp(
      "pqp-fixture-missing",
      { "index.html": PAGE, "main.js": "console.log(1)" },
      { assets: [{ name: "core.bin", path: "core.bin" }] },
    );
    await expect(buildApp(root, temp("pqp-out-"))).rejects.toThrow(/core\.bin/);
  });

  it("refuses a page with an inline script", async () => {
    const root = fixtureApp("pqp-fixture-inline", {
      "index.html": '<!doctype html><html><body><script>alert(1)</script></body></html>',
    });
    await expect(buildApp(root, temp("pqp-out-"))).rejects.toThrow(/inline <script>/);
  });

  it("refuses an invalid manifest source and names the problem", async () => {
    const root = fixtureApp("pqp-fixture-bad", { "index.html": PAGE, "main.js": "1" }, { icon: "not-an-icon" });
    await expect(buildApp(root, temp("pqp-out-"))).rejects.toThrow(/icon/);
  });

  it("refuses an entry that is not index.html", async () => {
    const root = fixtureApp(
      "pqp-fixture-entry",
      { "index.html": PAGE, "main.js": "1" },
      { entry: { path: "other.html" } },
    );
    await expect(buildApp(root, temp("pqp-out-"))).rejects.toThrow(/index\.html/);
  });
});
