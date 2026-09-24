import { describe, expect, it } from "vitest";
import { createIdempotencyKey, IdempotencyAttempt } from "./idempotency";

describe("createIdempotencyKey", () => {
  it("returns a non-empty, distinct id on each call", () => {
    const a = createIdempotencyKey();
    const b = createIdempotencyKey();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("IdempotencyAttempt", () => {
  it("reuses the same key for unchanged content, a retry of the same attempt", () => {
    const attempt = new IdempotencyAttempt();
    const first = attempt.keyFor("Sala");
    const second = attempt.keyFor("Sala");
    expect(second).toBe(first);
  });

  it("generates a fresh key when the content changes, a new attempt", () => {
    const attempt = new IdempotencyAttempt();
    const first = attempt.keyFor("Sala");
    const second = attempt.keyFor("Outra sala");
    expect(second).not.toBe(first);
  });

  it("starts a new attempt after reset even for the same content", () => {
    const attempt = new IdempotencyAttempt();
    const first = attempt.keyFor("Sala");
    attempt.reset();
    const second = attempt.keyFor("Sala");
    expect(second).not.toBe(first);
  });
});
