// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  useConfirmedGoneAuthors,
  type AuthorGoneCheck,
} from "./use-confirmed-gone-authors";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: AuthorGoneCheck;

function deferred() {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  return { promise, resolve };
}

function Probe({ serverId, refresh }: { serverId: string; refresh: () => Promise<boolean> }) {
  latest = useConfirmedGoneAuthors(serverId, refresh);
  return null;
}

function mount(serverId: string, refresh: () => Promise<boolean>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe serverId={serverId} refresh={refresh} />));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("useConfirmedGoneAuthors", () => {
  it("confirms an author only after a read that started once they were noticed", async () => {
    const reads = [deferred()];
    let calls = 0;
    mount("s1", () => reads[calls++]!.promise);
    act(() => latest.report(["a"]));
    expect(calls).toBe(1);
    expect(latest.confirmed.has("a")).toBe(false);
    reads[0]!.resolve(true);
    await settle();
    expect(latest.confirmed.has("a")).toBe(true);
  });

  it("makes an author reported mid-read wait for the next read", async () => {
    const reads = [deferred(), deferred()];
    let calls = 0;
    mount("s1", () => reads[calls++]!.promise);
    act(() => latest.report(["a"]));
    act(() => latest.report(["b"]));
    expect(calls).toBe(1);
    reads[0]!.resolve(true);
    await settle();
    expect(latest.confirmed.has("a")).toBe(true);
    expect(latest.confirmed.has("b")).toBe(false);
    expect(calls).toBe(2);
    reads[1]!.resolve(true);
    await settle();
    expect(latest.confirmed.has("b")).toBe(true);
  });

  it("reads once per author, and again after a failed read", async () => {
    const results = [false, true];
    let calls = 0;
    mount("s1", async () => results[calls++] ?? true);
    act(() => latest.report(["a"]));
    await settle();
    expect(latest.confirmed.size).toBe(0);
    act(() => latest.report(["a"]));
    await settle();
    expect(calls).toBe(2);
    expect(latest.confirmed.has("a")).toBe(true);
    act(() => latest.report(["a"]));
    await settle();
    expect(calls).toBe(2);
  });

  it("forgets everything when the server changes", async () => {
    let calls = 0;
    const refresh = async () => (calls++, true);
    mount("s1", refresh);
    act(() => latest.report(["a"]));
    await settle();
    expect(latest.confirmed.has("a")).toBe(true);
    act(() => root!.render(<Probe serverId="s2" refresh={refresh} />));
    await settle();
    expect(latest.confirmed.size).toBe(0);
    act(() => latest.report(["a"]));
    await settle();
    expect(calls).toBe(2);
  });
});
