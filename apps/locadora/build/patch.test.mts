import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMULATORJS_VERSION,
  EXPECTED_STYLE_CALLS,
  PatchError,
  patchFrontend,
  readFrontend,
} from "./patch.mts";

const frontendDir = dirname(createRequire(import.meta.url).resolve("@emulatorjs/emulatorjs/package.json"));
const original = readFrontend(frontendDir);

describe("the four EmulatorJS patches, on the installed frontend", () => {
  const patched = patchFrontend(original);

  it("is the version the needles were written for", () => {
    expect(EMULATORJS_VERSION).toBe("4.2.3");
  });

  it("unpack: a core container goes to window.PQP_UNPACK, anything else takes the original path", () => {
    expect(patched).toContain("window.PQP_UNPACK(data)");
    // the original line is still there, after the new branch
    expect(patched.indexOf("window.PQP_UNPACK(data)")).toBeLessThan(patched.indexOf("const compressed = this.isCompressed"));
    expect(patched.split("const compressed = this.isCompressed(data.slice(0, 10));").length - 1).toBe(1);
  });

  it("corejs: the glue comes from the bundle with its integrity, or the load is refused", () => {
    expect(patched).toContain("script.src = window.PQP_CORE_JS_URL;");
    expect(patched).toContain("script.integrity = sri;");
    expect(patched).toContain('script.crossOrigin = "anonymous";');
    expect(patched).toContain('throw new Error("no integrity for the core script")');
    // the refusal comes before the script is pointed anywhere
    expect(patched.indexOf("no integrity for the core script")).toBeLessThan(patched.indexOf("script.src = window.PQP_CORE_JS_URL;"));
  });

  it("style: no inline style is left, in code or in markup", () => {
    expect(patched).not.toMatch(/setAttribute\(\s*["']style["']/);
    expect(patched).not.toMatch(/<[a-zA-Z][^>]*\sstyle\s*=\s*["']/);
    // every call site went through the CSSOM helper
    expect((patched.match(/\(function \(e, v\) \{ e\.style\.cssText = v; \}\)\(/g) ?? []).length).toBe(EXPECTED_STYLE_CALLS);
    expect(patched).toContain('stroke-width="3" stroke-linecap="round"');
  });

  it("noupdate: the update check is gone", () => {
    expect(original).toContain("this.checkForUpdates();");
    expect(patched).not.toContain("this.checkForUpdates();");
  });

  it("keeps the netplay client library out", () => {
    expect(original).not.toContain("socket.io.min");
    expect(patched).not.toContain("io.connect(");
  });

  it("is deterministic", () => {
    expect(patchFrontend(original)).toBe(patched);
  });

  it("parses as a script", () => {
    expect(() => new Function(patched)).not.toThrow();
  });
});

describe("a changed EmulatorJS breaks the build loudly, naming the patch", () => {
  const cases: Array<[PatchError["patch"], string, string]> = [
    ["unpack", "const compressed = this.isCompressed(data.slice(0, 10));", "const compressed = this.isCompressed(data.slice(0, 12));"],
    ["corejs", 'script.src = URL.createObjectURL(new Blob([js], { type: "application/javascript" }));', "script.src = something.else();"],
    ["noupdate", "this.checkForUpdates();", "this.checkForUpdates(true);"],
  ];
  for (const [patch, needle, replacement] of cases) {
    it(`${patch}: needle missing`, () => {
      const changed = original.split(needle).join(replacement);
      expect(() => patchFrontend(changed)).toThrowError(PatchError);
      try {
        patchFrontend(changed);
      } catch (error) {
        expect((error as PatchError).patch).toBe(patch);
        expect((error as PatchError).message).toMatch(/exactly once, found 0/);
      }
    });
    it(`${patch}: needle twice`, () => {
      expect(() => patchFrontend(`${original}\n${needle}`)).toThrowError(/exactly once, found 2/);
    });
  }

  it("style: a new setAttribute('style') call is found and refused", () => {
    expect(() => patchFrontend(`${original}\nx.setAttribute("style", "a:b");`)).toThrowError(/setAttribute\("style"\) calls, found 6/);
  });

  it("style: a new inline style in markup is refused", () => {
    const changed = original.replace("viewBox=\"0 0 460 460\">", 'viewBox="0 0 460 460"><g style="x:y">');
    expect(changed).not.toBe(original);
    expect(() => patchFrontend(changed)).toThrowError(/inline style is still there/);
  });

  it("version: another frontend version is refused before anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "pqp-fake-ejs-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
      expect(() => readFrontend(dir)).toThrowError(/patches are for 4\.2\.3, the installed frontend is 9\.9\.9/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
