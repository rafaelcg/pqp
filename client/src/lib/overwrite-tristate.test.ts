import { describe, expect, it } from "vitest";
import { Permission } from "@pqp/shared";
import {
  applyListedOverwriteState,
  applyOverwriteState,
  overwriteBitsForChannel,
  overwriteState,
  shouldDeleteOverwrite,
} from "./overwrite-tristate";

const VIEW = Permission.VIEW_CHANNEL;
const SEND = Permission.SEND_MESSAGES;

describe("overwriteState", () => {
  it("maps allow, deny and inherit both ways", () => {
    expect(overwriteState(SEND, SEND, 0n)).toBe("allow");
    expect(overwriteState(SEND, 0n, SEND)).toBe("deny");
    expect(overwriteState(SEND, 0n, 0n)).toBe("inherit");
  });

  it("prefer allow when a row somehow set both", () => {
    expect(overwriteState(SEND, SEND, SEND)).toBe("allow");
  });
});

describe("applyOverwriteState", () => {
  it("clears the other side of the bit", () => {
    expect(applyOverwriteState(SEND, "deny", SEND, 0n)).toEqual({
      allow: 0n,
      deny: SEND,
    });
    expect(applyOverwriteState(SEND, "allow", 0n, SEND)).toEqual({
      allow: SEND,
      deny: 0n,
    });
    expect(applyOverwriteState(SEND, "inherit", SEND, 0n)).toEqual({
      allow: 0n,
      deny: 0n,
    });
  });

  it("leaves unlisted bits alone", () => {
    const next = applyListedOverwriteState(
      ["SEND_MESSAGES"],
      "SEND_MESSAGES",
      "deny",
      VIEW,
      0n,
    );
    expect(next.allow).toBe(VIEW);
    expect(next.deny).toBe(SEND);
  });
});

describe("shouldDeleteOverwrite", () => {
  it("is true only when the whole row is inherit", () => {
    expect(shouldDeleteOverwrite(0n, 0n)).toBe(true);
    expect(shouldDeleteOverwrite(VIEW, 0n)).toBe(false);
  });
});

describe("overwriteBitsForChannel", () => {
  it("uses CONNECT on voice and SEND on text", () => {
    expect(overwriteBitsForChannel("voice")).toContain("CONNECT");
    expect(overwriteBitsForChannel("text")).toContain("SEND_MESSAGES");
    expect(overwriteBitsForChannel("text")).toContain("MANAGE_MESSAGES");
    expect(overwriteBitsForChannel("text")).not.toContain("CONNECT");
  });
});
