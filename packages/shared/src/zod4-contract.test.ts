import { describe, expect, it } from "vitest";
import { auditChangeSchema } from "./audit.js";
import { forwardResultSchema } from "./forward.js";
import {
  DISPLAY_NAME_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
  USER_SEARCH_MAX_LENGTH,
  messageBodyTextSchema,
  messageReactionSchema,
  updateProfileSchema,
  userSearchQuerySchema,
  usernameSchema,
} from "./api.js";
import { JAM_TITLE_MAX, jamTitleSchema } from "./jam.js";
import { roleNameSchema } from "./permissions.js";
import { SEARCH_QUERY_MAX_LENGTH, messageSearchQuerySchema } from "./search.js";
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
    // (`char_length`) and what a person sees. It only differs for characters outside the
    // BMP (most emoji). A MAXIMUM can only get looser (code points never outnumber units),
    // so no request accepted before is refused now. A MINIMUM can get stricter, and the
    // audit of every `z.string().min(n)` with n >= 2 found exactly two that a client gates
    // on in UTF-16 units: the search boxes (below). The others are ASCII-only by regex.
    const emoji = "\u{1F600}";

    it("a maximum admits as many emoji as the limit says (it used to stop at half)", () => {
      expect(messageBodyTextSchema.safeParse(emoji.repeat(MESSAGE_MAX_LENGTH)).success).toBe(true);
      expect(messageBodyTextSchema.safeParse(emoji.repeat(MESSAGE_MAX_LENGTH + 1)).success).toBe(false);
      expect(messageBodyTextSchema.safeParse("a".repeat(MESSAGE_MAX_LENGTH)).success).toBe(true);
      expect(messageBodyTextSchema.safeParse("a".repeat(MESSAGE_MAX_LENGTH + 1)).success).toBe(false);
      expect(jamTitleSchema.safeParse(emoji.repeat(JAM_TITLE_MAX)).success).toBe(true);
      expect(jamTitleSchema.safeParse(emoji.repeat(JAM_TITLE_MAX + 1)).success).toBe(false);
      expect(
        updateProfileSchema.safeParse({ displayName: emoji.repeat(DISPLAY_NAME_MAX_LENGTH) }).success,
      ).toBe(true);
      expect(
        updateProfileSchema.safeParse({ displayName: emoji.repeat(DISPLAY_NAME_MAX_LENGTH + 1) }).success,
      ).toBe(false);
    });

    it("a lone emoji still reaches the search boxes' two-character minimum, as it did on zod 3", () => {
      // The web client and Android gate on `String.length` / Kotlin `length` (UTF-16), so a
      // lone emoji is a "searchable" query to both. The schema keeps counting it that way.
      for (const schema of [messageSearchQuerySchema, userSearchQuerySchema]) {
        expect(schema.safeParse("ok").success).toBe(true);
        expect(schema.safeParse(emoji).success).toBe(true);
        expect(schema.safeParse(`${emoji}${emoji}`).success).toBe(true);
        expect(schema.safeParse("a").success).toBe(false);
        expect(schema.safeParse("").success).toBe(false);
        expect(schema.safeParse("\u0000a").success).toBe(false);
      }
      // The maximum is the one that now counts code points: 200 and 32 emoji fit.
      expect(messageSearchQuerySchema.safeParse(emoji.repeat(SEARCH_QUERY_MAX_LENGTH)).success).toBe(true);
      expect(messageSearchQuerySchema.safeParse(emoji.repeat(SEARCH_QUERY_MAX_LENGTH + 1)).success).toBe(false);
      expect(userSearchQuerySchema.safeParse(emoji.repeat(USER_SEARCH_MAX_LENGTH)).success).toBe(true);
      expect(userSearchQuerySchema.safeParse(emoji.repeat(USER_SEARCH_MAX_LENGTH + 1)).success).toBe(false);
    });

    it("the other two-character minimums are ASCII by regex, so the counting cannot matter", () => {
      expect(usernameSchema.safeParse("ab").success).toBe(true);
      expect(usernameSchema.safeParse(emoji).success).toBe(false);
      expect(usernameSchema.safeParse(`${emoji}${emoji}`).success).toBe(false);
      expect(roleNameSchema.safeParse("ab").success).toBe(true);
      expect(roleNameSchema.safeParse(emoji).success).toBe(false);
      expect(roleNameSchema.safeParse(`${emoji}${emoji}`).success).toBe(false);
    });
  });

  describe(".int() is a safe integer now (the other deliberate difference)", () => {
    // zod 3's `.int()` took any integral double (1e300, 2^53 + 2); zod 4's takes only
    // |n| <= 2^53 - 1. Nothing in the clients sends one (counts, milliseconds, byte sizes).
    const count = messageReactionSchema.shape.count;

    it("accepts every integer a client can produce exactly", () => {
      expect(count.safeParse(1).success).toBe(true);
      expect(count.safeParse(Date.now()).success).toBe(true);
      expect(count.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    });

    it("refuses what no client sends, instead of storing a number it already rounded", () => {
      expect(count.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
      expect(count.safeParse(1e300).success).toBe(false);
      expect(count.safeParse(1.5).success).toBe(false);
    });
  });
});
