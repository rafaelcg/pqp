import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateAppManifest } from "@pqp/shared";
import { REPO_ROOT } from "./build.mts";
import {
  CATALOG_PATH,
  type Catalog,
  immutabilityViolations,
  inconsistentEntries,
  parseCatalog,
  readBaseCatalog,
  renderCatalog,
} from "./catalog.mts";
import { canonicalJson, manifestSha256 } from "./hash.mts";

const committed = parseCatalog(readFileSync(join(REPO_ROOT, CATALOG_PATH), "utf8"), CATALOG_PATH);
const eco = committed.apps.find((entry) => entry.manifest.id === "pqp-eco")!;

describe("the committed catalog (what the server loader reads)", () => {
  it("holds Eco as a valid built manifest with a consistent hash", () => {
    expect(eco).toBeDefined();
    expect(validateAppManifest(eco.manifest).ok).toBe(true);
    expect(eco.manifest.publisher).toBe("pqp");
    expect(eco.manifest.entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inconsistentEntries(committed)).toEqual([]);
  });

  it("is sorted by id and ends with a newline", () => {
    const ids = committed.apps.map((entry) => entry.manifest.id);
    expect(ids).toEqual([...ids].sort());
    expect(readFileSync(join(REPO_ROOT, CATALOG_PATH), "utf8").endsWith("}\n")).toBe(true);
  });
});

describe("hashes", () => {
  it("canonicalJson ignores key order, so manifestSha256 does too", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    const reverse = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverse)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)]))
          : value;
    expect(Object.keys(reverse(eco.manifest) as object)).not.toEqual(Object.keys(eco.manifest));
    expect(manifestSha256(reverse(eco.manifest))).toBe(eco.manifestSha256);
  });

  it("changes when any byte of the manifest changes", () => {
    expect(manifestSha256({ ...eco.manifest, version: "9.9.9" })).not.toBe(eco.manifestSha256);
  });
});

describe("renderCatalog", () => {
  it("sorts by id then version, whatever order it is given", () => {
    const make = (id: string, version: string) => ({
      manifest: { ...eco.manifest, id, version },
      manifestSha256: "x",
    });
    const text = renderCatalog([make("pqp-b", "1.0.0"), make("pqp-a", "1.1.0"), make("pqp-a", "1.0.0")]);
    const parsed = JSON.parse(text).apps.map((e: { manifest: { id: string; version: string } }) => `${e.manifest.id}@${e.manifest.version}`);
    expect(parsed).toEqual(["pqp-a@1.0.0", "pqp-a@1.1.0", "pqp-b@1.0.0"]);
  });
});

describe("immutabilityViolations", () => {
  const base: Catalog = committed;

  it("accepts an identical build, a new app and a new version", () => {
    expect(immutabilityViolations(base, base)).toEqual([]);
    const next: Catalog = {
      apps: [
        ...base.apps,
        { manifest: { ...eco.manifest, version: "1.1.0" }, manifestSha256: "different" },
        { manifest: { ...eco.manifest, id: "pqp-other" }, manifestSha256: "different" },
      ],
    };
    expect(immutabilityViolations(base, next)).toEqual([]);
  });

  it("refuses the same (id, version) with a different hash and says to bump the version", () => {
    const next: Catalog = { apps: [{ ...eco, manifestSha256: "0".repeat(64) }] };
    const violations = immutabilityViolations(base, next);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`pqp-eco@${eco.manifest.version}`);
    expect(violations[0]).toContain("bump the version");
  });

  it("does not mind a version that is gone from the sources", () => {
    expect(immutabilityViolations(base, { apps: [] })).toEqual([]);
  });
});

describe("readBaseCatalog", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "pqp-base-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    writeFileSync(join(dir, "README"), "x");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "one");
    return dir;
  }

  it("says no-ref without origin/main, empty with no catalog on it, and found with one", () => {
    const dir = repo();
    expect(readBaseCatalog(dir)).toEqual({ kind: "no-ref" });
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(readBaseCatalog(dir)).toEqual({ kind: "empty" });
    mkdirSync(join(dir, "server/src/apps"), { recursive: true });
    writeFileSync(join(dir, CATALOG_PATH), renderCatalog(committed.apps));
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "catalog");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    const base = readBaseCatalog(dir);
    expect(base.kind).toBe("found");
    if (base.kind === "found") expect(base.catalog.apps[0]!.manifest.id).toBe("pqp-eco");
  });
});
