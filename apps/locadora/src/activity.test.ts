// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createActivityReporter } from "./activity";
import { createHouseRules } from "./ui/house-rules";
import { STRINGS } from "./i18n";

describe("the activity reporter", () => {
  it("says each change once, in order", () => {
    const sink = vi.fn(async (_state: string) => null);
    const reporter = createActivityReporter(sink);
    for (const state of ["browsing", "playing", "playing", "paused", "paused", "playing", "browsing"] as const) reporter.report(state);
    expect(sink.mock.calls.map(([state]) => state)).toEqual(["browsing", "playing", "paused", "playing", "browsing"]);
    expect(reporter.current).toBe("browsing");
  });

  it("swallows a host that refuses or throws", async () => {
    const reporter = createActivityReporter(() => Promise.reject(new Error("invalid")));
    expect(() => reporter.report("paused")).not.toThrow();
    const throwing = createActivityReporter(() => {
      throw new Error("no port");
    });
    expect(() => throwing.report("paused")).not.toThrow();
    await Promise.resolve();
  });

  it("a report that failed is sent again the next time the same state is said", async () => {
    let fail = true;
    const sink = vi.fn(async (_state: string) => {
      if (fail) throw new Error("lost");
      return null;
    });
    const reporter = createActivityReporter(sink);
    reporter.report("playing");
    await Promise.resolve();
    await Promise.resolve();
    expect(reporter.current).toBeNull();
    fail = false;
    reporter.report("playing");
    await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(reporter.current).toBe("playing");
    reporter.report("playing");
    expect(sink).toHaveBeenCalledTimes(2);
    // a sink that throws outright is forgotten at once
    const throwing = createActivityReporter(() => {
      throw new Error("no port");
    });
    throwing.report("paused");
    expect(throwing.current).toBeNull();
  });

  it("sends nothing without a sink (an ordinary session)", () => {
    const reporter = createActivityReporter(null);
    reporter.report("playing");
    expect(reporter.current).toBeNull();
  });
});

describe("the receipt for a guest", () => {
  it("adds the browser-only line, keeps the legal lines, and never claims the account", () => {
    for (const t of Object.values(STRINGS)) {
      const guest = createHouseRules({ t, compact: false, guest: true, synced: true }).element.textContent ?? "";
      expect(guest).toContain(t["rules.guest"]);
      expect(guest).toContain(t["rules.1"]);
      expect(guest).toContain(t.privacy);
      expect(guest).toContain(t["rules.3"]);
      expect(guest).not.toContain(t["rules.sync"]);
      const member = createHouseRules({ t, compact: false }).element.textContent ?? "";
      expect(member).not.toContain(t["rules.guest"]);
    }
  });
});
