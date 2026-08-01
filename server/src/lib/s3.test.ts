import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteObject,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
  signRequest,
  StorageError,
} from "./s3.js";

/**
 * Signing is the one part of this feature with no forgiving failure mode: a
 * canonical request that is wrong by a byte still yields a well-formed URL,
 * and the bucket answers `SignatureDoesNotMatch` — which reads as a
 * credentials problem and is not one.
 *
 * So these assert the *inputs* to the signature rather than golden signature
 * strings, which could only be produced by running this same code and would
 * therefore pin a bug as readily as a fix. The one independently verifiable
 * step — that the string to sign hashes the canonical request — is checked
 * against `node:crypto` directly. End-to-end correctness comes from the MinIO
 * round trip at the bottom of this file.
 */

/** Obvious dummies. Never a real credential, not even an AWS doc example. */
const ENV = {
  S3_ENDPOINT: "https://account123.r2.cloudflarestorage.com",
  S3_BUCKET: "pqp-test",
  S3_REGION: "auto",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_FORCE_PATH_STYLE: "false",
  S3_PUBLIC_BASE_URL: "",
};

const S3_KEYS = [...Object.keys(ENV), "MAX_ATTACHMENT_BYTES"] as const;

const saved = new Map<string, string | undefined>();

/** A fixed clock, so `X-Amz-Date` and the credential scope are assertable. */
const NOW = new Date("2026-08-01T12:45:00.000Z");

function lines(canonicalRequest: string): string[] {
  return canonicalRequest.split("\n");
}

beforeEach(() => {
  for (const key of S3_KEYS) {
    saved.set(key, process.env[key]);
  }
  Object.assign(process.env, ENV);
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  saved.clear();
});

describe("storage configuration", () => {
  it("is off until endpoint, bucket and both credentials are present", () => {
    expect(isStorageConfigured()).toBe(true);

    for (const key of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      const value = process.env[key]!;
      process.env[key] = "";
      expect(isStorageConfigured()).toBe(false);
      process.env[key] = value;
    }

    expect(isStorageConfigured()).toBe(true);
  });

  it("refuses a malformed endpoint rather than signing for it", () => {
    process.env.S3_ENDPOINT = "not-a-url";
    expect(isStorageConfigured()).toBe(false);
    expect(() => presignPut("k", "image/png", 1024, 60)).toThrow(StorageError);
  });
});

describe("canonical request", () => {
  it("is the six SigV4 blocks, with an unsigned payload", () => {
    const signed = signRequest({
      method: "GET",
      key: "channel/file.png",
      ttlSeconds: 900,
      now: NOW,
    });
    // The header block ends with a newline of its own, so the empty line at
    // index 4 is part of the format rather than an accident — SigV4 counts it.
    expect(lines(signed.canonicalRequest)).toEqual([
      "GET",
      "/channel/file.png",
      expect.stringContaining("X-Amz-Algorithm=AWS4-HMAC-SHA256"),
      "host:pqp-test.account123.r2.cloudflarestorage.com",
      "",
      "host",
      // Not SHA256("") — see the note in s3.ts. A presigned request that hashes
      // the empty payload instead is rejected by every S3 implementation.
      "UNSIGNED-PAYLOAD",
    ]);
  });

  it("hashes into the string to sign, which node:crypto can confirm", () => {
    const signed = signRequest({
      method: "GET",
      key: "channel/file.png",
      ttlSeconds: 900,
      now: NOW,
    });
    const [algorithm, amzDate, scope, hash] = lines(signed.stringToSign);

    expect(algorithm).toBe("AWS4-HMAC-SHA256");
    expect(amzDate).toBe("20260801T124500Z");
    expect(scope).toBe("20260801/auto/s3/aws4_request");
    expect(hash).toBe(
      createHash("sha256").update(signed.canonicalRequest, "utf8").digest("hex"),
    );
  });

  it("sorts query parameters by encoded name, uppercase before lowercase", () => {
    const signed = signRequest({
      method: "GET",
      key: "k.pdf",
      ttlSeconds: 900,
      forRead: true,
      query: { "response-content-disposition": "attachment" },
      now: NOW,
    });

    // Byte order, not alphabetical: every `X-Amz-*` sorts ahead of a lowercase
    // `response-*`, which is the opposite of what reading it aloud suggests.
    expect(lines(signed.canonicalRequest)[2]).toBe(
      [
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        "X-Amz-Credential=test-access-key%2F20260801%2Fauto%2Fs3%2Faws4_request",
        "X-Amz-Date=20260801T124500Z",
        "X-Amz-Expires=900",
        "X-Amz-SignedHeaders=host",
        "response-content-disposition=attachment",
      ].join("&"),
    );
  });

  it("signs content-type for uploads, lowercased and sorted before host", () => {
    const signed = signRequest({
      method: "PUT",
      key: "k.png",
      ttlSeconds: 900,
      headers: { "Content-Type": "image/png" },
      now: NOW,
    });

    expect(lines(signed.canonicalRequest)[3]).toBe("content-type:image/png");
    expect(lines(signed.canonicalRequest)[4]).toBe("host:pqp-test.account123.r2.cloudflarestorage.com");
    expect(lines(signed.canonicalRequest)[6]).toBe("content-type;host");
    expect(signed.url).toContain("X-Amz-SignedHeaders=content-type%3Bhost");
  });

  it("signs the upload's content-length, so the grant is not open-ended", () => {
    const url = presignPut("k.png", "image/png", 4096, 900);
    const signedHeaders = new URL(url).searchParams.get("X-Amz-SignedHeaders");

    // Without this the signature constrains nothing about the body: a mint that
    // declared one byte could store gigabytes, and since that row is never
    // claimed the claim-time HEAD never runs to notice.
    expect(signedHeaders).toBe("content-length;content-type;host");

    const signed = signRequest({
      method: "PUT",
      key: "k.png",
      ttlSeconds: 900,
      headers: { "content-type": "image/png", "content-length": "4096" },
      now: NOW,
    });
    expect(lines(signed.canonicalRequest)[3]).toBe("content-length:4096");

    // A different declared size is a different signature — the bucket, not the
    // client, is what decides the size is right. Signed against a fixed clock,
    // since two live calls a second apart would differ for the wrong reason.
    const other = signRequest({
      method: "PUT",
      key: "k.png",
      ttlSeconds: 900,
      headers: { "content-type": "image/png", "content-length": "4097" },
      now: NOW,
    });
    expect(other.url).not.toBe(signed.url);
  });

  it("changes when the key changes and repeats when nothing does", () => {
    const request = { method: "GET", key: "a.png", ttlSeconds: 900, now: NOW } as const;
    const first = signRequest(request);
    const second = signRequest(request);
    const other = signRequest({ ...request, key: "b.png" });

    expect(first.url).toBe(second.url);
    expect(other.url).not.toBe(first.url);
    expect(first.url).toMatch(/&X-Amz-Signature=[0-9a-f]{64}$/);
  });
});

describe("key encoding", () => {
  it("percent-encodes the characters encodeURIComponent leaves alone", () => {
    const signed = signRequest({
      method: "GET",
      key: "chan/a b+c(1)*'!.png",
      ttlSeconds: 900,
      now: NOW,
    });

    // `/` stays a separator inside the canonical URI; everything else that is
    // not RFC 3986 unreserved goes, including the `!'()*` that
    // encodeURIComponent would have passed through untouched.
    expect(lines(signed.canonicalRequest)[1]).toBe(
      "/chan/a%20b%2Bc%281%29%2A%27%21.png",
    );
    expect(signed.url).not.toMatch(/[ +]/);
  });

  it("encodes `/` inside a query value, where it is not a separator", () => {
    const signed = signRequest({
      method: "GET",
      key: "k.png",
      ttlSeconds: 900,
      now: NOW,
    });
    expect(signed.canonicalRequest).toContain(
      "X-Amz-Credential=test-access-key%2F20260801%2Fauto%2Fs3%2Faws4_request",
    );
  });

  it("carries a non-ASCII filename in filename* and flattens the fallback", () => {
    const url = presignGet("k.pdf", {
      ttlSeconds: 900,
      downloadFilename: 'relatório "final".pdf',
    });
    const disposition = new URL(url).searchParams.get(
      "response-content-disposition",
    );

    // The quoted fallback must not contain a quote of its own, or a client
    // parses the rest of the filename as further header parameters.
    expect(disposition).toBe(
      `attachment; filename="relat_rio _final_.pdf"; filename*=UTF-8''relat%C3%B3rio%20%22final%22.pdf`,
    );
  });
});

describe("ttl", () => {
  const expires = (ttlSeconds: number) =>
    new URL(
      signRequest({ method: "GET", key: "k", ttlSeconds, now: NOW }).url,
    ).searchParams.get("X-Amz-Expires");

  it("clamps to the window SigV4 accepts", () => {
    expect(expires(900)).toBe("900");
    expect(expires(0)).toBe("1");
    expect(expires(-5)).toBe("1");
    expect(expires(3.9)).toBe("3");
    // Seven days is the ceiling; asking for ten silently gets seven rather
    // than a URL the bucket rejects outright.
    expect(expires(10 * 24 * 60 * 60)).toBe("604800");
    expect(expires(Number.NaN)).toBe("1");
  });
});

describe("addressing style", () => {
  it("puts the bucket in the path when MinIO needs it there", () => {
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_FORCE_PATH_STYLE = "true";

    const signed = signRequest({
      method: "GET",
      key: "chan/k.png",
      ttlSeconds: 900,
      now: NOW,
    });

    expect(lines(signed.canonicalRequest)[1]).toBe("/pqp-test/chan/k.png");
    // The signed host has to carry the port, or the request the browser sends
    // does not match the one that was signed.
    expect(lines(signed.canonicalRequest)[3]).toBe("host:localhost:9000");
    expect(signed.url.startsWith("http://localhost:9000/pqp-test/chan/k.png?")).toBe(true);
  });

  it("puts the bucket in the hostname otherwise", () => {
    const signed = signRequest({
      method: "GET",
      key: "chan/k.png",
      ttlSeconds: 900,
      now: NOW,
    });
    expect(signed.url.startsWith("https://pqp-test.account123.r2.cloudflarestorage.com/chan/k.png?")).toBe(true);
  });

  it("signs reads for the custom domain, with the bucket in neither place", () => {
    process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.com";

    const read = signRequest({ method: "GET", key: "chan/k.png", ttlSeconds: 900, forRead: true, now: NOW });
    const write = signRequest({ method: "PUT", key: "chan/k.png", ttlSeconds: 900, now: NOW });

    // A custom domain is bound to one bucket at the DNS layer, so repeating
    // the bucket in the path would address `bucket/bucket/key`.
    expect(lines(read.canonicalRequest)[1]).toBe("/chan/k.png");
    expect(lines(read.canonicalRequest)[3]).toBe("host:cdn.example.com");
    // Uploads keep going to the real endpoint: the custom domain is a read
    // surface and may not even accept writes.
    expect(lines(write.canonicalRequest)[3]).toBe("host:pqp-test.account123.r2.cloudflarestorage.com");
  });

  it("keeps a path prefix on the custom domain", () => {
    process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.com/files/";
    const signed = signRequest({ method: "GET", key: "chan/k.png", ttlSeconds: 900, forRead: true, now: NOW });
    expect(lines(signed.canonicalRequest)[1]).toBe("/files/chan/k.png");
  });
});

/**
 * The only test that proves the signature is *correct* rather than merely
 * stable. Opt in against the MinIO the repo already ships, rather than a
 * hand-rolled one — the `storage` profile creates the bucket for you, and its
 * credentials are the ones below:
 *
 *   docker compose --profile storage up -d minio minio-init
 *   S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_BUCKET=pqp-attachments \
 *     S3_TEST_ACCESS_KEY_ID=pqpminio S3_TEST_SECRET_ACCESS_KEY=pqpminio-dev-secret \
 *     S3_TEST_FORCE_PATH_STYLE=true \
 *     pnpm --filter @pqp/server test s3
 *
 * Name the two services explicitly. A bare `--profile storage up -d` also
 * starts the `app` container, which fails to bind :3001 against a running dev
 * server and buries this suite's output in an unrelated error.
 */
const describeMinio = process.env.S3_TEST_ENDPOINT ? describe : describe.skip;

describeMinio("round trip against real storage", () => {
  beforeEach(() => {
    process.env.S3_ENDPOINT = process.env.S3_TEST_ENDPOINT!;
    process.env.S3_BUCKET = process.env.S3_TEST_BUCKET!;
    process.env.S3_ACCESS_KEY_ID = process.env.S3_TEST_ACCESS_KEY_ID!;
    process.env.S3_SECRET_ACCESS_KEY = process.env.S3_TEST_SECRET_ACCESS_KEY!;
    process.env.S3_REGION = process.env.S3_TEST_REGION ?? "us-east-1";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_PUBLIC_BASE_URL = "";
  });

  it("uploads, reads back, and deletes a key with awkward characters", async () => {
    // The characters that break a hand-rolled encoder, in the one place the
    // bucket can actually adjudicate who was right.
    const key = `test/${randomUUID()}/a b+c(1).txt`;
    const body = "hello attachment";

    const put = await fetch(
      presignPut(key, "text/plain", Buffer.byteLength(body), 300),
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body,
      },
    );
    expect(put.status).toBe(200);

    const head = await headObject(key);
    expect(head).toEqual({
      contentLength: Buffer.byteLength(body),
      contentType: "text/plain",
    });

    const get = await fetch(
      presignGet(key, { ttlSeconds: 300, downloadFilename: "relatório.txt" }),
    );
    expect(await get.text()).toBe(body);
    // The response override is signed in, so the bucket is what forces the
    // download — nothing user-uploaded can be talked into rendering inline.
    expect(get.headers.get("content-disposition")).toContain("attachment");
    expect(get.headers.get("content-disposition")).toContain("filename*=UTF-8''");

    await deleteObject(key);
    expect(await headObject(key)).toBeNull();
    // Deleting twice is a success, which is what lets the sweeper retry.
    await expect(deleteObject(key)).resolves.toBeUndefined();
  });

  it("refuses an upload that sends a different content type than was signed", async () => {
    const key = `test/${randomUUID()}.txt`;
    const body = "<script>alert(1)</script>";
    const response = await fetch(
      presignPut(key, "text/plain", Buffer.byteLength(body), 300),
      {
        method: "PUT",
        headers: { "Content-Type": "text/html" },
        body,
      },
    );

    // Signing the content type is what keeps the allowlist meaningful past the
    // moment the URL is minted.
    expect(response.ok).toBe(false);
    expect(await headObject(key)).toBeNull();
  });

  it("refuses a body of any length other than the one that was signed", async () => {
    const key = `test/${randomUUID()}.txt`;
    // The URL was minted for one byte; the bucket is what stops it being used
    // to store an arbitrarily large object nobody will ever claim or sweep.
    const response = await fetch(presignPut(key, "text/plain", 1, 300), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(4096),
    });

    expect(response.ok).toBe(false);
    expect(await headObject(key)).toBeNull();
  });
});
