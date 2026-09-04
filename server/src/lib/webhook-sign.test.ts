import { describe, expect, it } from "vitest";
import {
  generateSigningSecret,
  hmacSha256Base64,
  secretHint,
  signatureHeader,
  signedContent,
  signV1,
  verifySignatureHeader,
} from "./webhook-sign.js";

describe("Standard Webhooks signer", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const ts = 1_700_000_000;
  const body = '{"type":"message.created"}';

  it("signs HMAC-SHA256 over id.ts.body and verifies timing-safe", () => {
    const secret = generateSigningSecret();
    expect(secret.startsWith("whsec_")).toBe(true);

    const content = signedContent(id, ts, body);
    expect(content).toBe(`${id}.${ts}.${body}`);

    const header = signV1(secret, id, ts, body);
    expect(header.startsWith("v1,")).toBe(true);
    expect(header.slice(3)).toBe(hmacSha256Base64(secret, content));

    expect(verifySignatureHeader(secret, id, ts, body, header)).toBe(true);
    expect(
      verifySignatureHeader(secret, id, ts, body, "v1,AAAAAAAAAAAAAAAAAAAAAA=="),
    ).toBe(false);
    expect(
      verifySignatureHeader(generateSigningSecret(), id, ts, body, header),
    ).toBe(false);
  });

  it("emits two space-delimited v1 signatures during rotation", () => {
    const current = generateSigningSecret();
    const previous = generateSigningSecret();
    const header = signatureHeader([current, previous], id, ts, body);
    const parts = header.split(" ");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(signV1(current, id, ts, body));
    expect(parts[1]).toBe(signV1(previous, id, ts, body));
    expect(verifySignatureHeader(current, id, ts, body, header)).toBe(true);
    expect(verifySignatureHeader(previous, id, ts, body, header)).toBe(true);
  });

  it("signs the exact UTF-8 bytes: a re-serialized body does not verify", () => {
    const secret = generateSigningSecret();
    const pretty = '{\n  "type": "message.created"\n}';
    const header = signV1(secret, id, ts, body);
    expect(verifySignatureHeader(secret, id, ts, pretty, header)).toBe(false);
  });

  it("hints the last four characters of a secret", () => {
    expect(secretHint("whsec_abcdefgh")).toBe("efgh");
  });
});
