// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REDESIGN_STORAGE_KEY,
  isRedesignOn,
  redesignFromConfig,
  resetRedesignForTests,
  setRedesignChoice,
  setRedesignFlag,
} from "./redesign";

const attr = () => document.documentElement.hasAttribute("data-redesign");

function setUrl(search: string) {
  window.history.replaceState(null, "", `/app${search}`);
}

describe("the redesign toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    setUrl("");
    delete document.documentElement.dataset.redesign;
    resetRedesignForTests();
  });
  afterEach(() => {
    setUrl("");
  });

  it("is off with no choice and the flag off, and draws nothing", () => {
    expect(isRedesignOn()).toBe(false);
    expect(attr()).toBe(false);
  });

  it("follows the flag when the person never chose", () => {
    setRedesignFlag(true);
    expect(isRedesignOn()).toBe(true);
    expect(attr()).toBe(true);
    setRedesignFlag(false);
    expect(attr()).toBe(false);
  });

  it("lets the person's choice win over the flag in both directions", () => {
    setRedesignFlag(true);
    setRedesignChoice(false);
    expect(localStorage.getItem(REDESIGN_STORAGE_KEY)).toBe("off");
    expect(attr()).toBe(false);
    setRedesignFlag(false);
    setRedesignChoice(true);
    expect(attr()).toBe(true);
  });

  it("lets the URL win over the choice, for one page", () => {
    setRedesignChoice(true);
    setUrl("?redesign=0");
    expect(isRedesignOn()).toBe(false);
    setRedesignChoice(false);
    setUrl("?redesign=1");
    expect(isRedesignOn()).toBe(true);
  });

  it("reads only an explicit true from the config", () => {
    expect(redesignFromConfig({ redesign: true })).toBe(true);
    expect(redesignFromConfig({ redesign: "true" })).toBe(false);
    expect(redesignFromConfig({})).toBe(false);
  });
});
