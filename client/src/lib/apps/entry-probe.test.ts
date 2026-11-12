import { describe, expect, it, vi } from "vitest";
import { probeAppEntry } from "./entry-probe";

const URL_ = "https://apps.example/pqp-locadora/1.0.3/index.html";

describe("probeAppEntry", () => {
  it("asks with a cookieless, referrer-less CORS GET that follows the Pages redirect", async () => {
    const fetchImpl = vi.fn(async () => new Response("<!doctype html>", { status: 200 }));
    const signal = new AbortController().signal;
    expect(await probeAppEntry(URL_, signal, fetchImpl as unknown as typeof fetch)).toEqual({ kind: "ok" });
    expect(fetchImpl).toHaveBeenCalledWith(URL_, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "follow",
      signal,
    });
  });

  it("calls an HTTP error missing, with its status", async () => {
    const fetchImpl = async () => new Response("Not found", { status: 404 });
    expect(await probeAppEntry(URL_, new AbortController().signal, fetchImpl as typeof fetch)).toEqual({
      kind: "missing",
      status: 404,
    });
  });

  it("calls no answer unknown, never missing (offline, no CORS header, aborted)", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await probeAppEntry(URL_, new AbortController().signal, fetchImpl as typeof fetch)).toEqual({
      kind: "unknown",
    });
  });
});
