/**
 * The gate, pinned.
 *
 * This is the test that protects self-hosters. pqp is AGPL, `index.html` ships
 * with the source, and a Google tag that leaked into it would put somebody
 * else's visitors into our advertising account and set Google cookies on their
 * domain. The property is one line long and can be broken by a one-line
 * refactor, so it gets its own file rather than a corner of another one.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { googleAds, googleAdsTags } from "./google-ads-tag";

/** Everything the injected tags would put on the page, as one string. */
function injected(env: Parameters<typeof googleAdsTags>[0]): string {
  return JSON.stringify(googleAdsTags(env));
}

const GOOGLE_MARKERS = [/googletagmanager/i, /gtag/i, /\bAW-/, /dataLayer/i];

describe("googleAdsTags", () => {
  it("injects nothing when no advertiser id is configured", () => {
    expect(googleAdsTags({})).toEqual([]);
    expect(googleAdsTags({ VITE_GOOGLE_ADS_ID: "" })).toEqual([]);
    expect(googleAdsTags({ VITE_GOOGLE_ADS_ID: "   " })).toEqual([]);
  });

  it("leaves no trace of Google in the output of an unconfigured build", () => {
    for (const marker of GOOGLE_MARKERS) {
      expect(injected({}), `unconfigured build leaked ${marker}`).not.toMatch(
        marker,
      );
    }
  });

  it("does not inject on the strength of the label alone", () => {
    // A half-configured build is an unconfigured build. The label addresses a
    // conversion action inside an account that has not been named.
    expect(googleAdsTags({ VITE_GOOGLE_ADS_SIGNUP_LABEL: "abc123" })).toEqual(
      [],
    );
  });

  it("loads the tag and configures the account when the id is set", () => {
    const tags = googleAdsTags({ VITE_GOOGLE_ADS_ID: "AW-123456789" });
    expect(tags).toHaveLength(2);
    // The library is requested after the page has loaded and gone idle, not
    // with the head, so the tag is an inline loader that names the URL.
    expect(tags[0]).toMatchObject({ tag: "script", injectTo: "head" });
    expect(tags[0].attrs).toBeUndefined();
    expect(String(tags[0].children)).toContain(
      "https://www.googletagmanager.com/gtag/js?id=AW-123456789",
    );
    expect(String(tags[0].children)).toContain("requestIdleCallback");
    const inline = String(tags[1].children);
    expect(inline).toContain('window.gtag("config", "AW-123456789")');
    // An arrow function here would forward no `arguments` and gtag would push
    // empty objects into dataLayer forever.
    expect(inline).toContain("function () { window.dataLayer.push(arguments); }");
  });

  it("escapes an id rather than letting it close the string it sits in", () => {
    const hostile = 'AW-1");alert(1);//';
    const tags = googleAdsTags({ VITE_GOOGLE_ADS_ID: hostile });
    const inline = String(tags[1].children);
    // The quote that would have ended the string literal is escaped, so the
    // whole value stays one argument to `config` instead of becoming a
    // statement of its own.
    expect(inline).toContain(`window.gtag("config", ${JSON.stringify(hostile)})`);
    expect(inline).toContain('\\"');
    expect(inline).not.toContain('"AW-1");alert');
  });
});

describe("the googleAds plugin", () => {
  it("is a build-only plugin that injects nothing without an id", () => {
    const plugin = googleAds({});
    expect(plugin.name).toBe("pqp-google-ads");
    expect(plugin.apply).toBe("build");
    const hook = plugin.transformIndexHtml;
    expect(typeof hook).toBe("function");
    expect((hook as () => unknown)()).toEqual([]);
  });
});

describe("the shipped index.html", () => {
  it("carries no Google tag of its own", () => {
    // The other half of the same property: the gate is worth nothing if
    // somebody later pastes the snippet into the template it guards.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(path.resolve(here, "../../index.html"), "utf8");
    for (const marker of GOOGLE_MARKERS) {
      expect(html, `index.html carries ${marker}`).not.toMatch(marker);
    }
  });
});

describe("the pages the tag must not load on (decision D3: /apps*, /locadora*)", () => {
  /**
   * The injected scripts, run as the browser would, on a given path. Records
   * whether anything reached Google: a `dataLayer`, a `gtag` or a script
   * appended to the head (the library request).
   */
  function runOn(pathname: string) {
    const appended: unknown[] = [];
    const listeners: Array<() => void> = [];
    const addEventListener = (_name: string, fn: () => void) => {
      listeners.push(fn);
    };
    const win: Record<string, unknown> = {
      addEventListener,
      setTimeout: (fn: () => void) => fn(),
      requestIdleCallback: (fn: () => void) => fn(),
    };
    const document = {
      readyState: "complete",
      documentElement: { getAttribute: () => "other" },
      head: { appendChild: (node: unknown) => appended.push(node) },
      createElement: () => ({ setAttribute() {} }),
    };
    win.window = win;
    win.document = document;
    const context = vm.createContext({
      ...win,
      window: win,
      document,
      location: { pathname },
      Date,
    });
    for (const tag of googleAdsTags({ VITE_GOOGLE_ADS_ID: "AW-123456789" })) {
      vm.runInContext(String(tag.children), context);
    }
    // The first touch fires the loader too.
    for (const fn of listeners) fn();
    return { appended, win };
  }

  it.each(["/apps", "/apps/", "/apps/locadora", "/locadora", "/locadora/x"])(
    "loads nothing, defines nothing and queues nothing on %s",
    (pathname) => {
      const { appended, win } = runOn(pathname);
      expect(appended).toEqual([]);
      expect(win.dataLayer).toBeUndefined();
      expect(win.gtag).toBeUndefined();
    },
  );

  it.each(["/", "/app", "/vem", "/appstore", "/locadoras", "/c/apps", "/@locadora"])(
    "still loads and configures on %s",
    (pathname) => {
      const { appended, win } = runOn(pathname);
      expect(appended.length).toBeGreaterThan(0);
      expect(JSON.stringify(win.dataLayer)).toContain("config");
      expect(typeof win.gtag).toBe("function");
    },
  );
});
