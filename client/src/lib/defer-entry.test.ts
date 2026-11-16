import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineEnv, scriptBody } from "@/test/inline-script-env";
import { INTERACTIONS } from "./boot-gate";
import { deferEntryLoader, deferEntryScript } from "./defer-entry";

const ENTRY = '<script type="module" crossorigin src="/assets/index-abc123.js"></script>';

describe("deferEntryScript", () => {
  it("swaps the entry tag for the loader and keeps the file name", () => {
    const html = `<head>${ENTRY}<link rel="stylesheet" href="/x.css"></head>`;
    const out = deferEntryScript(html);
    expect(out).not.toContain(ENTRY);
    expect(out).toContain("/assets/index-abc123.js");
    expect(out).toContain('<link rel="stylesheet" href="/x.css">');
  });

  it("leaves a document with no entry tag alone", () => {
    const html = "<head><title>x</title></head>";
    expect(deferEntryScript(html)).toBe(html);
  });

  it("listens for the same first interactions as the boot gate", () => {
    expect(deferEntryLoader("/a.js")).toContain(`${JSON.stringify(INTERACTIONS)}.forEach(`);
  });

  it("cannot be closed early by a hostile file name", () => {
    const out = deferEntryLoader('/a</script><script>alert(1)//.js');
    expect(out.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("the chat client preload", () => {
  const APP = "assets/App-xyz789.js";

  it("names the App chunk in the loader, from the directory the entry is served from", () => {
    const out = deferEntryScript(`<head>${ENTRY}</head>`, APP);
    expect(out).toContain("/assets/App-xyz789.js");
    // A build with no such chunk (a custom build, the dev server) gets no preload.
    expect(deferEntryScript(`<head>${ENTRY}</head>`)).not.toContain("modulepreload");
  });

  it("cannot be closed early by a hostile chunk name", () => {
    const out = deferEntryLoader("/assets/index-abc123.js", "/a</script><script>alert(1)//.js");
    expect(out.match(/<\/script>/g)).toHaveLength(1);
  });

  const source = scriptBody(deferEntryLoader("/assets/index-abc123.js", "/assets/App-xyz789.js"));

  it("preloads the chat client beside the entry on /app and every route under it", () => {
    for (const path of ["/app", "/app/", "/app/server/abc/channel/def", "/app/invite/xyz", "/app/dm"]) {
      const env = inlineEnv({ route: "other", path });
      env.run(source);
      expect(env.appended.map((node) => node.rel ?? node.type), path).toEqual([
        "modulepreload",
        "module",
      ]);
      expect(env.appended[0], path).toMatchObject({
        href: "/assets/App-xyz789.js",
        crossOrigin: "",
      });
      // The preload is in the document BEFORE the entry is requested.
      expect(env.appended[1]?.src).toBe("/assets/index-abc123.js");
    }
  });

  it("does not preload it anywhere else: the landing page and the marketing routes never need it", () => {
    for (const [route, path] of [
      ["home", "/"],
      ["other", "/vem"],
      ["other", "/c/valorant"],
      ["other", "/@rafa"],
      ["other", "/apple"],
      ["other", "/application"],
    ] as const) {
      const env = inlineEnv({ route, path });
      env.run(source);
      env.fire("pointerdown");
      expect(
        env.appended.filter((node) => node.rel === "modulepreload"),
        path,
      ).toHaveLength(0);
    }
  });
});

describe("the chat client's own imports", () => {
  const ENTRY_FILE = "/assets/index-abc123.js";
  const deps = ["assets/user-avatar-1.js", "assets/index-abc123.js", "assets/menu-2.js"];
  const html = deferEntryScript(`<head>${ENTRY}</head>`, "assets/App-xyz789.js", deps);
  const source = scriptBody(html.slice(html.indexOf("<script>")));

  it("preloads them on /app after the entry, at low priority, and never the entry twice", () => {
    const env = inlineEnv({ route: "other", path: "/app/dm" });
    env.run(source);
    expect(env.appended.map((node) => node.href ?? node.src)).toEqual([
      "/assets/App-xyz789.js",
      ENTRY_FILE,
      "/assets/user-avatar-1.js",
      "/assets/menu-2.js",
    ]);
    for (const node of env.appended.slice(2)) {
      expect(node).toMatchObject({ rel: "modulepreload", crossOrigin: "", fetchPriority: "low" });
    }
  });

  it("asks for none of them off /app", () => {
    for (const [route, path] of [
      ["home", "/"],
      ["other", "/vem"],
      ["other", "/application"],
    ] as const) {
      const env = inlineEnv({ route, path });
      env.run(source);
      env.fire("pointerdown");
      expect(env.appended.filter((node) => node.rel === "modulepreload"), path).toHaveLength(0);
    }
  });

  it("cannot be closed early by a hostile chunk name", () => {
    const out = deferEntryLoader(ENTRY_FILE, "/assets/App.js", ["/a</script><script>alert(1)//.js"]);
    expect(out.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("the loader, run as the browser would", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const source = scriptBody(deferEntryLoader("/assets/index-abc123.js"));

  it("starts the bundle at once on every route but the home page", () => {
    const env = inlineEnv({ route: "other" });
    env.run(source);
    expect(env.appended).toHaveLength(1);
    expect(env.appended[0]).toMatchObject({
      src: "/assets/index-abc123.js",
      type: "module",
      crossOrigin: "",
    });
  });

  it("does not start it at parse time on the home page", () => {
    const env = inlineEnv({ route: "home" });
    env.run(source);
    expect(env.appended).toHaveLength(0);
  });

  it("starts it 300 ms after the first screen has settled", () => {
    const env = inlineEnv({ route: "home" });
    env.run(source);
    env.paint([{ url: "" }]);
    env.fire("load");
    vi.advanceTimersByTime(299);
    expect(env.appended).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(env.appended).toHaveLength(1);
  });

  it("waits again when a later picture is painted", () => {
    const env = inlineEnv({ route: "home" });
    env.run(source);
    env.paint([{}]);
    vi.advanceTimersByTime(200);
    env.paint([{ url: "hero.webp" }]);
    vi.advanceTimersByTime(200);
    expect(env.appended).toHaveLength(0);
    vi.advanceTimersByTime(101);
    expect(env.appended).toHaveLength(1);
  });

  it("starts on the first touch, click, key press or wheel turn", () => {
    for (const name of ["pointerdown", "keydown", "touchstart", "wheel"]) {
      const env = inlineEnv({ route: "home" });
      env.run(source);
      env.fire(name);
      expect(env.appended, name).toHaveLength(1);
    }
  });

  it("starts by the ceiling when nothing else happens", () => {
    const env = inlineEnv({ route: "home", hasObserver: false });
    env.run(source);
    vi.advanceTimersByTime(2999);
    expect(env.appended).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(env.appended).toHaveLength(1);
  });

  it("starts the bundle exactly once", () => {
    const env = inlineEnv({ route: "home" });
    env.run(source);
    env.fire("pointerdown");
    env.fire("keydown");
    env.paint([{}]);
    env.fire("load");
    vi.advanceTimersByTime(10_000);
    expect(env.appended).toHaveLength(1);
  });
});
