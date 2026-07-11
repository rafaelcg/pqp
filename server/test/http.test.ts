import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readJsonBody } from "../dist/lib/http.js";

function reqFrom(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

describe("readJsonBody", () => {
  it("parses valid JSON", async () => {
    const out = await readJsonBody(reqFrom(JSON.stringify({ a: 1 })));
    expect(out).toEqual({ a: 1 });
  });

  it("treats an empty body as {}", async () => {
    expect(await readJsonBody(reqFrom(""))).toEqual({});
  });

  it("rejects invalid JSON with a 400", async () => {
    await expect(readJsonBody(reqFrom("{nope"))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects an oversized body with a 413", async () => {
    const big = "x".repeat(300 * 1024);
    await expect(
      readJsonBody(reqFrom(JSON.stringify({ big }))),
    ).rejects.toMatchObject({ status: 413 });
  });
});
