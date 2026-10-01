import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineEnv } from "@/test/inline-script-env";
import { deferredScriptSource, deferredScriptTag } from "./deferred-tag";

describe("deferredScriptTag", () => {
  it("is an inline head script, not a script that names the URL itself", () => {
    const tag = deferredScriptTag("https://cloud.umami.is/script.js", {
      attrs: { "data-website-id": "abc" },
    });
    expect(tag).toMatchObject({ tag: "script", injectTo: "head" });
    expect(tag.attrs).toBeUndefined();
    expect(String(tag.children)).toContain("https://cloud.umami.is/script.js");
    expect(String(tag.children)).toContain('"data-website-id"');
  });

  it("cannot be closed early by a hostile value", () => {
    const source = deferredScriptSource("https://x.test/a.js", {
      attrs: { "data-website-id": '</script><script>alert(1)//' },
    });
    expect(source).not.toContain("</script>");
  });
});

describe("the tag loader, run as the browser would", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const source = deferredScriptSource("https://cloud.umami.is/script.js", {
    attrs: { "data-website-id": "abc" },
  });

  it("requests the script with its attributes, async", () => {
    const env = inlineEnv({ route: "other", readyState: "complete" });
    env.run(source);
    vi.advanceTimersByTime(10);
    expect(env.appended).toHaveLength(1);
    expect(env.appended[0]).toMatchObject({
      src: "https://cloud.umami.is/script.js",
      async: true,
      attrs: { "data-website-id": "abc" },
    });
  });

  it("does not request anything while the page is still loading", () => {
    const env = inlineEnv({ route: "other", readyState: "loading" });
    env.run(source);
    vi.advanceTimersByTime(60_000);
    expect(env.appended).toHaveLength(0);
  });

  it("requests it once the page has loaded and the browser is idle", () => {
    const env = inlineEnv({ route: "other", readyState: "loading" });
    env.run(source);
    env.fire("load");
    vi.advanceTimersByTime(10);
    expect(env.appended).toHaveLength(1);
  });

  it("on the home page waits for the first screen to settle", () => {
    const env = inlineEnv({ route: "home", readyState: "complete" });
    env.run(source);
    env.paint([{ url: "hero.webp" }]);
    vi.advanceTimersByTime(299);
    expect(env.appended).toHaveLength(0);
    vi.advanceTimersByTime(20);
    expect(env.appended).toHaveLength(1);
  });

  it("requests it on the first interaction, whatever the page is doing", () => {
    const env = inlineEnv({ route: "home", readyState: "loading" });
    env.run(source);
    env.fire("keydown");
    expect(env.appended).toHaveLength(1);
  });

  it("requests it only once", () => {
    const env = inlineEnv({ route: "home", readyState: "loading" });
    env.run(source);
    env.fire("pointerdown");
    env.fire("touchstart");
    env.fire("load");
    vi.advanceTimersByTime(60_000);
    expect(env.appended).toHaveLength(1);
  });
});
