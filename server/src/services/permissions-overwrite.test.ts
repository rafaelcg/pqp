import { describe, expect, it } from "vitest";
import { Permission } from "@pqp/shared";
import { coerceEveryoneViewOverwrite } from "./permissions.js";

const VIEW = Permission.VIEW_CHANNEL;
const SEND = Permission.SEND_MESSAGES;

describe("coerceEveryoneViewOverwrite", () => {
  it("forces VIEW deny on a private channel and keeps other bits", () => {
    const next = coerceEveryoneViewOverwrite(true, VIEW | SEND, 0n);
    expect(next.allow & VIEW).toBe(0n);
    expect(next.deny & VIEW).toBe(VIEW);
    expect(next.allow & SEND).toBe(SEND);
  });

  it("strips VIEW from both sides on a public channel", () => {
    const next = coerceEveryoneViewOverwrite(false, VIEW, VIEW | SEND);
    expect(next.allow & VIEW).toBe(0n);
    expect(next.deny & VIEW).toBe(0n);
    expect(next.deny & SEND).toBe(SEND);
  });
});
