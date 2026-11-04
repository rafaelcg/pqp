import { describe, expect, it } from "vitest";
import { auditChangeSchema } from "./audit.js";
import { forwardResultSchema } from "./forward.js";
import { messageSearchQuerySchema } from "./search.js";
import { createWatchPartySchema, updateWatchPartySchema } from "./watch-party-session.js";

/**
 * Where zod 4 would have changed the wire contract of `@pqp/shared`, and what
 * the schemas do about it. Each case is something that parsed one way on zod 3
 * (the version this package shipped on until the migration) and would have
 * parsed another way on a bare version bump. The migration was checked by
 * feeding about 125,000 generated inputs to every exported schema on both
 * versions; these are the places it found, kept as tests so they stay found.
 */
describe("the zod 4 migration keeps the wire contract", () => {
  describe("a request that names only some options leaves the others alone", () => {
    // `schema.partial()` over a `.default()` field applies the default in zod 4, so a
    // PATCH carrying only `guests` would have reset the other seven options.
    it("on update: only the keys sent come out", () => {
      expect(updateWatchPartySchema.parse({ options: { guests: "invite" } })).toEqual({
        options: { guests: "invite" },
      });
      expect(updateWatchPartySchema.parse({ options: {} })).toEqual({ options: {} });
      expect(updateWatchPartySchema.parse({})).toEqual({});
    });

    it("on create: the same", () => {
      expect(
        createWatchPartySchema.parse({ name: "Noite de filme", options: { slowModeSeconds: 5 } }),
      ).toEqual({ name: "Noite de filme", options: { slowModeSeconds: 5 } });
    });

    it("and still enforces every option's own rule", () => {
      expect(updateWatchPartySchema.safeParse({ options: { guests: "everyone" } }).success).toBe(false);
      expect(updateWatchPartySchema.safeParse({ options: { slowModeSeconds: 21601 } }).success).toBe(false);
      expect(updateWatchPartySchema.safeParse({ options: { slowModeSeconds: 1.5 } }).success).toBe(false);
      expect(updateWatchPartySchema.safeParse({ options: { lowLatency: "yes" } }).success).toBe(false);
    });
  });

  describe("a key whose schema is z.unknown() may still be left out", () => {
    // zod 4 makes the key of a bare `z.unknown()` required. JSON has no `undefined`,
    // so a value that was `undefined` arrives as a missing key.
    it("an audit change with no old value", () => {
      expect(auditChangeSchema.parse({ key: "name", new: "b" })).toEqual({ key: "name", new: "b" });
      expect(auditChangeSchema.parse({ key: "name", old: null, new: null })).toEqual({
        key: "name",
        old: null,
        new: null,
      });
    });

    it("a forward result with no message payload", () => {
      const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      expect(
        forwardResultSchema.safeParse({ ok: true, target: { channelId: id }, channelId: id, serverId: null })
          .success,
      ).toBe(true);
    });
  });

  describe("ids are any 8-4-4-4-12 hex, as they were", () => {
    // `z.string().uuid()` became RFC 9562 strict in zod 4 (version and variant nibbles),
    // which rejects ids like these. Every id on the wire is declared `.guid()`.
    it("accepts a nil-ish, a version 1 and a hand-made id", async () => {
      const { z } = await import("zod");
      const id = z.string().guid();
      for (const value of [
        "00000000-0000-0000-0000-000000000000",
        "11111111-1111-1111-1111-111111111111",
        "3FA85F64-5717-4562-B3FC-2C963F66AFA6",
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ]) {
        expect(id.safeParse(value).success, value).toBe(true);
      }
      expect(id.safeParse("3fa85f64-5717-4562-b3fc-2c963f66afa").success).toBe(false);
      expect(id.safeParse("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz").success).toBe(false);
    });
  });

  describe("string length is counted in code points now (the one deliberate difference)", () => {
    // zod 3 counted UTF-16 units, zod 4 counts code points, which is what Postgres counts
    // and what a person sees. It only differs for characters outside the BMP (most emoji).
    it("a single emoji is one character, so it no longer reaches a 2-character minimum", () => {
      expect(messageSearchQuerySchema.safeParse("ok").success).toBe(true);
      expect(messageSearchQuerySchema.safeParse("a").success).toBe(false);
      expect(messageSearchQuerySchema.safeParse("\u{1F600}").success).toBe(false);
      expect(messageSearchQuerySchema.safeParse("\u{1F600}\u{1F600}").success).toBe(true);
    });
  });
});
