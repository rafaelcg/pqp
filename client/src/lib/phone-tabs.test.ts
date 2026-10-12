import { afterEach, describe, expect, it } from "vitest";
import {
  arrivedForPerson,
  isPhoneTab,
  landingPhoneTab,
  PHONE_TAB_STORAGE_KEY,
  readStoredPhoneTab,
  storePhoneTab,
} from "@/lib/phone-tabs";

afterEach(() => {
  try {
    localStorage.removeItem(PHONE_TAB_STORAGE_KEY);
  } catch {
    // no storage in this environment
  }
});

describe("landingPhoneTab", () => {
  it("starts on Servidores for anybody with no stored choice, new or old", () => {
    expect(landingPhoneTab({ stored: null, arrivedForPerson: false })).toBe("servidores");
  });

  it("opens on the last tab used", () => {
    expect(landingPhoneTab({ stored: "conversas", arrivedForPerson: false })).toBe("conversas");
    expect(landingPhoneTab({ stored: "tu", arrivedForPerson: false })).toBe("tu");
  });

  it("lands on Conversas for somebody who came for a person", () => {
    expect(landingPhoneTab({ stored: "servidores", arrivedForPerson: true })).toBe("conversas");
  });
});

describe("arrivedForPerson", () => {
  it("is a conversation link or an ?add= link", () => {
    expect(arrivedForPerson({ pathname: "/app/dm/abc", search: "" })).toBe(true);
    expect(arrivedForPerson({ pathname: "/app", search: "?add=rafa" })).toBe(true);
    expect(arrivedForPerson({ pathname: "/app", search: "?join=qg" })).toBe(false);
    expect(arrivedForPerson({ pathname: "/app/server/x", search: "" })).toBe(false);
  });
});

describe("the stored tab", () => {
  it("round-trips, and ignores anything that is not a tab", () => {
    if (typeof localStorage === "undefined") {
      return;
    }
    storePhoneTab("tu");
    expect(readStoredPhoneTab()).toBe("tu");
    localStorage.setItem(PHONE_TAB_STORAGE_KEY, "banana");
    expect(readStoredPhoneTab()).toBeNull();
    expect(isPhoneTab("conversas")).toBe(true);
  });
});
