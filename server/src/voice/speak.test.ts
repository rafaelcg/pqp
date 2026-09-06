import { describe, expect, it, vi } from "vitest";

/**
 * `resolveCanSpeak` is the one answer to "may this person talk here". The
 * permission arithmetic itself (roles, overwrites, owner, administrator) is
 * pinned in packages/shared and services/permissions-overwrite.test.ts; this
 * file pins what voice does with it: which channels are exempt, and that the
 * channel's overwrites are consulted rather than the server-wide bits.
 */

const resolved = vi.hoisted(() => ({
  calls: [] as Array<[string, string, string | null | undefined]>,
  bits: 0n,
}));

vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async (
    serverId: string,
    userId: string,
    channelId?: string | null,
  ) => {
    resolved.calls.push([serverId, userId, channelId]);
    return resolved.bits;
  },
}));

const { resolveCanSpeak } = await import("./speak.js");
const { Permission } = await import("@pqp/shared");

const SERVER = "server-1";
const CHANNEL = "channel-1";

describe("resolveCanSpeak", () => {
  it("is true for a conversation call, whatever the bits say", async () => {
    resolved.calls.length = 0;
    resolved.bits = 0n;
    await expect(
      resolveCanSpeak(
        { kind: "conversation", server_id: null },
        CHANNEL,
        "user-1",
      ),
    ).resolves.toBe(true);
    // No roles to consult: nothing was resolved.
    expect(resolved.calls).toHaveLength(0);
  });

  it("is true when the channel cannot be placed (permissive by default)", async () => {
    resolved.bits = 0n;
    await expect(resolveCanSpeak(null, CHANNEL, "user-1")).resolves.toBe(true);
    await expect(
      resolveCanSpeak({ kind: "server", server_id: null }, CHANNEL, "user-1"),
    ).resolves.toBe(true);
  });

  it("follows SPEAK, resolved with the channel's overwrites, in a server room", async () => {
    resolved.calls.length = 0;
    resolved.bits = Permission.CONNECT | Permission.SPEAK;
    await expect(
      resolveCanSpeak({ kind: "server", server_id: SERVER }, CHANNEL, "user-1"),
    ).resolves.toBe(true);

    resolved.bits = Permission.CONNECT;
    await expect(
      resolveCanSpeak({ kind: "server", server_id: SERVER }, CHANNEL, "user-1"),
    ).resolves.toBe(false);

    // The channel id travels, so a per-channel deny (the stage setup) is what
    // gets answered, not the member's server-wide bits.
    expect(resolved.calls).toEqual([
      [SERVER, "user-1", CHANNEL],
      [SERVER, "user-1", CHANNEL],
    ]);
  });
});
