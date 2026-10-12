import { afterEach, describe, expect, it } from "vitest";
import {
  conversationsConfig,
  conversationsConfigFrom,
  loadConversationsConfig,
  setConversationsConfigForTests,
} from "@/lib/conversations-config";

afterEach(() => {
  setConversationsConfigForTests({ home: false, phoneTabs: false });
});

describe("conversationsConfigFrom", () => {
  it("is off for anything but an explicit true", () => {
    expect(conversationsConfigFrom({})).toEqual({ home: false, phoneTabs: false });
    expect(conversationsConfigFrom({ home: "true", phoneTabs: 1 })).toEqual({
      home: false,
      phoneTabs: false,
    });
    expect(conversationsConfigFrom({ home: true })).toEqual({ home: true, phoneTabs: false });
  });

  it("never turns the phone tabs on without home", () => {
    expect(conversationsConfigFrom({ home: false, phoneTabs: true })).toEqual({
      home: false,
      phoneTabs: false,
    });
    expect(conversationsConfigFrom({ home: true, phoneTabs: true })).toEqual({
      home: true,
      phoneTabs: true,
    });
  });
});

describe("loadConversationsConfig", () => {
  it("applies the answer, and keeps the last one when a read fails", async () => {
    await loadConversationsConfig(async () => ({ home: true, phoneTabs: true }));
    expect(conversationsConfig()).toEqual({ home: true, phoneTabs: true });
    await loadConversationsConfig(async () => {
      throw new Error("404");
    });
    expect(conversationsConfig()).toEqual({ home: true, phoneTabs: true });
  });

  it("does not let a slow older answer undo a newer one", async () => {
    let releaseSlow: (value: { home: boolean }) => void = () => {};
    const slow = loadConversationsConfig(
      () => new Promise((resolve) => (releaseSlow = resolve)),
    );
    await loadConversationsConfig(async () => ({ home: false }));
    releaseSlow({ home: true });
    await slow;
    expect(conversationsConfig().home).toBe(false);
  });
});
