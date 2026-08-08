import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uploaded profile pictures.
 *
 * Two things are worth testing here and the rest is plumbing. One is that a key
 * from the request cannot name somebody else's object — the claim accepts a
 * client-supplied key, which `message_attachments` deliberately does not, and
 * the *only* thing standing between that and an avatar overwrite is the prefix
 * check. The other is that the HEAD refuses everything it is supposed to: an
 * object that was never uploaded, one bigger than the cap, and one stored as a
 * different type than the URL was signed for.
 *
 * Storage is faked, exactly as in attachments.test.ts, and for the same reason:
 * the signature itself is proved against a real bucket in `lib/s3.test.ts`, and
 * what matters here is what the service does with the answer.
 */

const storage = vi.hoisted(() => ({
  configured: true,
  objects: new Map<string, { contentLength: number; contentType: string }>(),
  deletedKeys: [] as string[],
  unreachableKeys: new Set<string>(),
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => storage.configured,
  presignPut: (key: string, contentType: string, byteSize: number) =>
    `https://storage.test/${key}?type=${encodeURIComponent(contentType)}&len=${byteSize}`,
  presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
  headObject: async (key: string) => {
    if (storage.unreachableKeys.has(key)) {
      throw new Error("storage unreachable");
    }
    return storage.objects.get(key) ?? null;
  },
  deleteObject: async (key: string) => {
    if (storage.unreachableKeys.has(key)) {
      throw new Error("storage unreachable");
    }
    storage.deletedKeys.push(key);
    storage.objects.delete(key);
  },
}));

const pool = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  query: vi.fn(async () => ({ rows: pool.rows })),
}));

vi.mock("../db.js", () => ({ getPool: () => pool }));

const {
  avatarObjectKey,
  avatarUrlForKey,
  createAvatarUpload,
  discardAvatarObject,
  isAvatarUploadConfigured,
  isOwnAvatarKey,
  presignAvatarRead,
  verifyAvatarObject,
} = await import("./avatars.js");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  storage.configured = true;
  storage.objects.clear();
  storage.deletedKeys.length = 0;
  storage.unreachableKeys.clear();
  pool.rows = [];
  pool.query.mockClear();
});

/** Mint an upload and pretend the browser finished the PUT. */
function upload(
  options: {
    user?: string;
    contentType?: "image/jpeg" | "image/png" | "image/webp";
    bytes?: number;
    storedContentType?: string;
    skipUpload?: boolean;
  } = {},
) {
  const contentType = options.contentType ?? "image/jpeg";
  const minted = createAvatarUpload({
    userId: options.user ?? USER,
    contentType,
    byteSize: options.bytes ?? 40_000,
  });
  if (!options.skipUpload) {
    storage.objects.set(minted.key, {
      contentLength: options.bytes ?? 40_000,
      contentType: options.storedContentType ?? contentType,
    });
  }
  return minted;
}

describe("avatar keys", () => {
  it("namespaces every key under the account that minted it", () => {
    expect(avatarObjectKey(USER, "image/jpeg")).toMatch(
      new RegExp(`^avatars/${USER}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(avatarObjectKey(USER, "image/png")).toMatch(/\.png$/);
    expect(avatarObjectKey(USER, "image/webp")).toMatch(/\.webp$/);
  });

  it("never derives the extension from anything a client sends", () => {
    // The suffix comes from the content type, which is an enum. There is no
    // input that reaches the key other than the session's own user id.
    for (const type of ["image/jpeg", "image/png", "image/webp"] as const) {
      expect(avatarObjectKey(USER, type)).not.toContain("..");
    }
  });

  it("refuses a key belonging to another account", () => {
    const mine = avatarObjectKey(USER, "image/jpeg");
    expect(isOwnAvatarKey(USER, mine)).toBe(true);
    expect(isOwnAvatarKey(OTHER, mine)).toBe(false);
  });

  it("refuses traversal that starts with the right prefix", () => {
    expect(isOwnAvatarKey(USER, `avatars/${USER}/../${OTHER}/x.jpg`)).toBe(false);
  });

  it("refuses the bare prefix, which names the folder and not an object", () => {
    expect(isOwnAvatarKey(USER, `avatars/${USER}/`)).toBe(false);
  });

  it("changes the served URL whenever the key changes", () => {
    const first = avatarUrlForKey(USER, avatarObjectKey(USER, "image/jpeg"));
    const second = avatarUrlForKey(USER, avatarObjectKey(USER, "image/jpeg"));
    expect(first).toMatch(new RegExp(`^/api/avatars/${USER}\\?v=[0-9a-f]{8}$`));
    // Two different objects, two different addresses — this is the whole of the
    // cache-busting story, and without it a new avatar shows as the old one.
    expect(first).not.toBe(second);
  });
});

describe("createAvatarUpload", () => {
  it("signs the declared type and length into the PUT", () => {
    const minted = createAvatarUpload({
      userId: USER,
      contentType: "image/png",
      byteSize: 1234,
    });
    expect(minted.uploadUrl).toContain("type=image%2Fpng");
    expect(minted.uploadUrl).toContain("len=1234");
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("writes nothing, so an abandoned upload leaves the old avatar alone", () => {
    createAvatarUpload({ userId: USER, contentType: "image/jpeg", byteSize: 10 });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("verifyAvatarObject", () => {
  it("accepts an object that is there and is what was signed", async () => {
    const minted = upload({ bytes: 40_000 });
    await expect(verifyAvatarObject(USER, minted.key)).resolves.toBe(40_000);
  });

  it("refuses an upload that never happened", async () => {
    const minted = upload({ skipUpload: true });
    await expect(verifyAvatarObject(USER, minted.key)).resolves.toBeNull();
  });

  it("refuses an object stored as a different type than was signed", async () => {
    const minted = upload({
      contentType: "image/png",
      storedContentType: "text/html",
    });
    await expect(verifyAvatarObject(USER, minted.key)).resolves.toBeNull();
  });

  it("refuses an object past the cap, whatever the PUT was signed for", async () => {
    const minted = createAvatarUpload({
      userId: USER,
      contentType: "image/jpeg",
      byteSize: 1000,
    });
    storage.objects.set(minted.key, {
      contentLength: 6 * 1024 * 1024,
      contentType: "image/jpeg",
    });
    await expect(verifyAvatarObject(USER, minted.key)).resolves.toBeNull();
  });

  it("refuses a zero-byte object", async () => {
    const minted = createAvatarUpload({
      userId: USER,
      contentType: "image/jpeg",
      byteSize: 1000,
    });
    storage.objects.set(minted.key, { contentLength: 0, contentType: "image/jpeg" });
    await expect(verifyAvatarObject(USER, minted.key)).resolves.toBeNull();
  });

  it("refuses another account's object even when the bytes are perfect", async () => {
    const minted = upload({ user: OTHER });
    await expect(verifyAvatarObject(USER, minted.key)).resolves.toBeNull();
  });

  it("refuses when the HEAD cannot be made at all", async () => {
    const minted = upload();
    storage.unreachableKeys.add(minted.key);
    await expect(verifyAvatarObject(USER, minted.key)).resolves.toBeNull();
  });

  it("refuses everything when storage is unconfigured", async () => {
    const minted = upload();
    storage.configured = false;
    expect(isAvatarUploadConfigured()).toBe(false);
    await expect(verifyAvatarObject(USER, minted.key)).resolves.toBeNull();
  });
});

describe("discardAvatarObject", () => {
  it("deletes the object", async () => {
    const minted = upload();
    await discardAvatarObject(minted.key);
    expect(storage.deletedKeys).toEqual([minted.key]);
  });

  it("swallows a storage failure — a profile change already committed", async () => {
    const minted = upload();
    storage.unreachableKeys.add(minted.key);
    await expect(discardAvatarObject(minted.key)).resolves.toBeUndefined();
  });

  it("does nothing at all without storage", async () => {
    storage.configured = false;
    await discardAvatarObject("avatars/x/y.jpg");
    expect(storage.deletedKeys).toEqual([]);
  });
});

describe("presignAvatarRead", () => {
  it("signs a read for the account's stored key", async () => {
    pool.rows = [{ avatar_key: `avatars/${USER}/pic.jpg` }];
    await expect(presignAvatarRead(USER)).resolves.toBe(
      `https://storage.test/avatars/${USER}/pic.jpg?sig=get`,
    );
  });

  it("answers null for an account with no uploaded avatar", async () => {
    pool.rows = [{ avatar_key: null }];
    await expect(presignAvatarRead(USER)).resolves.toBeNull();
  });

  it("answers null for an account that does not exist", async () => {
    pool.rows = [];
    await expect(presignAvatarRead(USER)).resolves.toBeNull();
  });

  it("answers null — not a signature — when storage is unconfigured", async () => {
    storage.configured = false;
    await expect(presignAvatarRead(USER)).resolves.toBeNull();
    // And does not go to the database for an answer it cannot use.
    expect(pool.query).not.toHaveBeenCalled();
  });
});
