import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emulatorAssets, SHIPPED_CORES } from "./emulator-assets";

/**
 * The emulator room's page, its policy and its files, read from disk. The room
 * is only legal to ship in principle if a game file cannot leave the browser
 * and the repository holds no game: both are checked here.
 */
const publicDir = path.resolve(import.meta.dirname, "../../public/emulator");
const html = readFileSync(path.join(publicDir, "frame.html"), "utf8");
const script = readFileSync(path.join(publicDir, "frame.js"), "utf8");

const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
const directive = (name: string) =>
  csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));

describe("the frame's policy", () => {
  it("is there, and starts from nothing allowed", () => {
    expect(csp).not.toBe("");
    expect(directive("default-src")).toBe("default-src 'none'");
  });

  it("allows the network to this origin only, and no way out through a form or a frame", () => {
    expect(directive("connect-src")).toBe("connect-src 'self' blob: data:");
    expect(directive("form-action")).toBe("form-action 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("frame-src")).toBeUndefined();
    expect(directive("child-src")).toBeUndefined();
  });

  it("names no remote host anywhere", () => {
    expect(csp).not.toMatch(/https?:|\*|wss?:/);
  });
});

describe("the room page that holds the frame", () => {
  const roomHtml = readFileSync(path.join(publicDir, "room.html"), "utf8");
  const roomJs = readFileSync(path.join(publicDir, "room.js"), "utf8");
  const roomCode = roomJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const roomCsp =
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(roomHtml)?.[1] ?? "";
  const roomDirective = (name: string) =>
    roomCsp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `));

  it("carries the frame-src that stops the emulator's frame navigating itself away", () => {
    // A frame's navigations are checked against the page that EMBEDS it, which
    // is the only control there is for self-navigation (there is no
    // `navigate-to`). Verified in a real browser with a crafted frame and a
    // canary server; see docs/EMULATOR_ROOM.md.
    expect(roomDirective("frame-src")).toBe("frame-src 'self'");
    expect(roomDirective("default-src")).toBe("default-src 'none'");
    expect(roomDirective("script-src")).toBe("script-src 'self'");
    expect(roomCsp).not.toMatch(/https?:|\*|unsafe-/);
    expect(roomDirective("connect-src")).toBeUndefined();
  });

  it("creates the emulator's frame sandboxed to scripts only, never same-origin", () => {
    expect(roomCode).toContain('element.setAttribute("sandbox", "allow-scripts")');
    expect(roomCode).not.toContain("allow-same-origin");
    expect(roomCode).not.toMatch(/allow-(top-navigation|popups|forms|modals|downloads|pointer-lock)/);
    expect(roomCode).toContain('var FRAME_SRC = "/emulator/frame.html"');
  });

  it("removes a frame that loads a second time, and tells the app", () => {
    expect(roomCode).toMatch(/frameLoads > 1/);
    expect(roomCode).toMatch(/removeFrame\(\);\s*up\(\{ type: "pqp-emulator-error", reason: "navigated" \}\)/);
  });

  it("only trusts the app (same origin) and its own frame (opaque origin), and talks up to the app's origin", () => {
    expect(roomCode).toMatch(/event\.source === window\.parent/);
    expect(roomCode).toMatch(/event\.origin !== appOrigin/);
    expect(roomCode).toMatch(/event\.source !== frame\.contentWindow \|\| event\.origin !== FRAME_ORIGIN/);
    expect(roomCode).toContain("window.parent.postMessage(message, appOrigin)");
    // The only "*" is the one to the frame, which has no nameable origin.
    expect([...roomCode.matchAll(/"\*"/g)]).toHaveLength(1);
  });

  it("repeats ready until the file arrives, so the first message cannot be lost", () => {
    expect(roomCode).toMatch(/setInterval\(function \(\) \{\s*up\(\{ type: "pqp-emulator-ready" \}\);/);
    expect(roomCode).toContain("window.clearInterval(readyTimer)");
  });

  it("has no way to send, keep or log the file", () => {
    for (const forbidden of [
      /\bfetch\b/,
      /\bXMLHttpRequest\b/,
      /\bsendBeacon\b/,
      /\bWebSocket\b/,
      /\bFormData\b/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\bindexedDB\b/,
      /\bconsole\b/,
      /\bcreateObjectURL\b/,
      /\.name\b/,
    ]) {
      expect(roomCode, `room.js must not use ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

describe("frame.js", () => {
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("has no way to send, keep or log the file", () => {
    for (const forbidden of [
      /\bfetch\b/,
      /\bXMLHttpRequest\b/,
      /\bsendBeacon\b/,
      /\bWebSocket\b/,
      /\bFormData\b/,
      /\bsessionStorage\b/,
      /\bindexedDB\b/,
      /\bconsole\b/,
      /\bcreateObjectURL\b/,
    ]) {
      expect(code, `frame.js must not use ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("touches web storage only to say there is none (a sandboxed page has none)", () => {
    const uses = code.split("\n").filter((line) => /localStorage/.test(line));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toContain("Object.defineProperty(window");
    expect(uses[0]).toContain("value: null");
  });

  it("answers only the window that embedded it, from the origin it was told (the page runs in an opaque origin)", () => {
    expect(code).toMatch(
      /!parentOrigin \|\| event\.origin !== parentOrigin \|\| event\.source !== window\.parent/,
    );
    // It talks back only to that origin, never to "*".
    expect(code).toMatch(/window\.parent\.postMessage\(message, parentOrigin\)/);
    expect(code).not.toMatch(/postMessage\([^)]*"\*"/);
  });

  it("switches the emulator's databases and settings storage off, and hides what would write", () => {
    expect(code).toContain("window.EJS_disableDatabases = true");
    expect(code).toContain("window.EJS_disableLocalStorage = true");
    expect(code).toMatch(/saveState: false/);
    expect(code).toMatch(/netplay: false/);
  });

  it("repeats ready until it has the file, so the first message cannot be lost", () => {
    expect(code).toMatch(/setInterval\(function \(\) \{\s*if \(started\) \{\s*window\.clearInterval\(readyTimer\)/);
  });

  it("gives the emulator a fixed name, never the player's", () => {
    expect(code).toContain('window.EJS_gameName = "rom." + extension');
  });

  it("loads only cores that ship", () => {
    const named = [...code.matchAll(/:\s*"([a-z0-9_]+)",?\s*$/gm)]
      .map((match) => match[1]!)
      .filter((name) => !["nes", "gb", "gbc", "gba"].includes(name));
    for (const core of named) {
      expect(SHIPPED_CORES.map((c) => c.core)).toContain(core);
    }
  });
});

describe("what is shipped", () => {
  const assets = emulatorAssets();

  it("is the two cores named, with their licenses, and no others", () => {
    expect(SHIPPED_CORES).toEqual([
      { core: "fceumm", pkg: "@emulatorjs/core-fceumm", license: "GPL-2.0-or-later" },
      { core: "mgba", pkg: "@emulatorjs/core-mgba", license: "MPL-2.0" },
    ]);
    const cores = [...assets.keys()]
      .filter((key) => key.startsWith("cores/") && !key.startsWith("cores/reports/"))
      .sort();
    expect(cores).toEqual([
      "cores/fceumm-legacy-wasm.data",
      "cores/fceumm-wasm.data",
      "cores/mgba-legacy-wasm.data",
      "cores/mgba-wasm.data",
    ]);
  });

  it("does not carry a core whose license forbids commercial use", () => {
    const keys = [...assets.keys()].join("\n");
    for (const refused of ["snes9x", "genesis_plus_gx", "picodrive"]) {
      expect(keys).not.toContain(refused);
    }
  });

  it("has every file present on disk", () => {
    for (const [key, asset] of assets) {
      if (asset.kind === "file") {
        expect(statSync(asset.from).isFile(), key).toBe(true);
      }
    }
  });

  it("leaves out the netplay client library", () => {
    expect(assets.has("emulator.min.js")).toBe(true);
    const bundle = assets.get("emulator.min.js")!;
    expect(bundle.kind === "text" && /Socket\.IO v\d/.test(bundle.text)).toBe(false);
  });
});

describe("no game in the repository", () => {
  // Every extension a console image or a disc dump comes in. `.bin` and `.zip`
  // are here on purpose: nothing under the emulator's own paths is either.
  const GAME_EXTENSION =
    /\.(nes|fds|unf|unif|sfc|smc|swc|fig|gb|gbc|gba|nds|3ds|md|gen|smd|32x|sms|gg|pce|n64|z64|v64|iso|bin|cue|chd|cso|zip|7z|rar)$/i;

  function walk(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((entry) =>
      statSync(path.join(dir, entry)).isFile(),
    );
  }

  it("holds no game file under the emulator's public folder", () => {
    for (const file of walk(publicDir)) {
      expect(GAME_EXTENSION.test(file), file).toBe(false);
    }
  });

  it("serves no game file from the packages either", () => {
    for (const key of emulatorAssets().keys()) {
      expect(GAME_EXTENSION.test(key), key).toBe(false);
    }
  });

  it("holds no game file in the client's own emulator code", () => {
    const roots = [
      path.resolve(import.meta.dirname, "emulator"),
      path.resolve(import.meta.dirname, "../components/emulator"),
    ];
    for (const root of roots) {
      for (const file of walk(root)) {
        expect(GAME_EXTENSION.test(file), file).toBe(false);
      }
    }
  });
});
