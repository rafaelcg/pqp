// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { APP_THEME_MAX_TOKENS } from "@pqp/shared";
import { APP_COLOR_SCHEME_TOKEN, APP_THEME_TOKENS, readThemeTokens, sameTheme } from "./theme-tokens";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

describe("readThemeTokens", () => {
  it("reads only the allowlisted design tokens, as the browser resolved them", () => {
    const root = document.documentElement;
    root.style.setProperty("--color-text", "oklch(0.93 0.015 95)");
    root.style.setProperty("--radius-card", "0.5rem");
    root.style.setProperty("--color-secret-internal", "red");
    root.style.setProperty("--chat-font-size", "15px");
    const theme = readThemeTokens(root);
    expect(theme["--color-text"]).toBe("oklch(0.93 0.015 95)");
    expect(theme["--radius-card"]).toBe("0.5rem");
    expect(theme).not.toHaveProperty("--color-secret-internal");
    expect(theme).not.toHaveProperty("--chat-font-size");
  });

  it("leaves a token out when it is unset or longer than the bridge allows", () => {
    const root = document.documentElement;
    root.style.setProperty("--font-sans", "x".repeat(300));
    const theme = readThemeTokens(root);
    expect(theme).not.toHaveProperty("--font-sans");
    expect(theme).not.toHaveProperty("--color-accent");
  });

  it("adds the colour scheme from data-theme, dark by default", () => {
    const root = document.documentElement;
    expect(readThemeTokens(root)[APP_COLOR_SCHEME_TOKEN]).toBe("dark");
    root.dataset.theme = "light";
    expect(readThemeTokens(root)[APP_COLOR_SCHEME_TOKEN]).toBe("light");
  });

  it("never exceeds the bridge's token cap, even with every token set", () => {
    const root = document.documentElement;
    for (const name of APP_THEME_TOKENS) root.style.setProperty(name, "1");
    expect(Object.keys(readThemeTokens(root)).length).toBeLessThanOrEqual(APP_THEME_MAX_TOKENS);
    expect(APP_THEME_TOKENS.length + 1).toBeLessThanOrEqual(APP_THEME_MAX_TOKENS);
  });
});

describe("sameTheme", () => {
  it("compares names and values", () => {
    expect(sameTheme({ "--a": "1" }, { "--a": "1" })).toBe(true);
    expect(sameTheme({ "--a": "1" }, { "--a": "2" })).toBe(false);
    expect(sameTheme({ "--a": "1" }, { "--a": "1", "--b": "1" })).toBe(false);
  });
});
