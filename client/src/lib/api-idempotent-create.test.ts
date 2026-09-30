import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDiscordImport, createServer, setAuthTokenProvider } from "./api";

/**
 * The `Idempotency-Key` header pqp#807/#806 asked for: an optional header on
 * the two room-creating POSTs, generated once per attempt on the caller's
 * side (`@/lib/idempotency`) and forwarded here unchanged. Nothing about the
 * key's semantics belongs in this file (the server side is proved in
 * `server/src/api/idempotent-create.test.ts`), only that `createServer` and
 * `applyDiscordImport` actually put it on the wire, and that omitting it (an
 * old caller) sends exactly what was sent before this feature existed.
 */

let fetchSpy: ReturnType<typeof vi.fn>;

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 201,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => okResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  setAuthTokenProvider(async () => "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function headersOf(callIndex: number): Record<string, string> {
  const [, options] = fetchSpy.mock.calls[callIndex] as [string, RequestInit];
  return options.headers as Record<string, string>;
}

describe("createServer", () => {
  it("sends no Idempotency-Key header when none is given", async () => {
    await createServer("Sala");
    expect(headersOf(0)["Idempotency-Key"]).toBeUndefined();
  });

  it("sends the given key on the Idempotency-Key header", async () => {
    await createServer("Sala", "attempt-abc");
    expect(headersOf(0)["Idempotency-Key"]).toBe("attempt-abc");
  });

  it("sends the same header value on a retry with the same key", async () => {
    await createServer("Sala", "attempt-abc");
    await createServer("Sala", "attempt-abc");
    expect(headersOf(0)["Idempotency-Key"]).toBe("attempt-abc");
    expect(headersOf(1)["Idempotency-Key"]).toBe("attempt-abc");
  });
});

describe("applyDiscordImport", () => {
  it("sends no Idempotency-Key header when none is given", async () => {
    await applyDiscordImport("abcd1234");
    expect(headersOf(0)["Idempotency-Key"]).toBeUndefined();
  });

  it("sends the given key on the Idempotency-Key header", async () => {
    await applyDiscordImport("abcd1234", "import-attempt-1");
    expect(headersOf(0)["Idempotency-Key"]).toBe("import-attempt-1");
  });
});
