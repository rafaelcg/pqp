// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppConfigEntry } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTransport, users } from "@/lib/apps/bridge-host.fixture";
import type { EntryProbeResult } from "@/lib/apps/entry-probe";

/**
 * The pane in the full app view, with the REAL frame controller under it: what
 * the person sees when the frame never comes up. Pinned after 2026-11-12, when
 * the version Locadora was pinned to was no longer on the apps site and the host
 * sat on a white 404 page under "Abrindo Locadora..." (docs/APPS.md, "Deploy").
 */

const probe = vi.hoisted(() => ({
  answer: { kind: "ok" } as EntryProbeResult,
  asked: [] as string[],
}));
vi.mock("@/lib/apps/entry-probe", () => ({
  probeAppEntry: async (url: string) => {
    probe.asked.push(url);
    return probe.answer;
  },
}));

import { AppPane } from "./app-pane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY = "http://localhost:5175/pqp-locadora/1.0.3/index.html";

const locadora = {
  id: "pqp-locadora",
  version: "1.0.3",
  entry: { url: ENTRY },
  assets: [],
  capabilities: { identity: "display", share: "pane", localFiles: { allowed: false }, peer: "none" },
  players: { min: 1, max: 8, spectators: true },
  shareAllowed: false,
} as unknown as AppConfigEntry;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  probe.answer = { kind: "ok" };
  probe.asked = [];
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.head.querySelectorAll("meta").forEach((meta) => meta.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(transport = new FakeTransport()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <AppPane
        app={locadora}
        origin="http://localhost:5175"
        title="Locadora"
        transport={transport}
        users={users}
        locale="pt-BR"
      />,
    );
  });
  return transport;
}

const pane = () => host!.querySelector<HTMLElement>('[data-testid="app-pane"]')!;
const retry = () =>
  [...host!.querySelectorAll("button")].find((b) => /Tentar de novo|Try again/.test(b.textContent ?? ""));

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("AppPane, a frame that never comes up", () => {
  it("turns 'Abrindo...' into an alert with Tentar de novo when the hello never comes (the 20 s backstop)", async () => {
    probe.answer = { kind: "unknown" }; // the probe saw nothing: only the timeout can say it
    const transport = render();
    await advance(10);
    expect(pane().dataset.status).toBe("loading");
    expect(host!.querySelector('[role="status"]')?.textContent).toMatch(/Locadora/);
    expect(host!.querySelector("iframe")).not.toBeNull();

    await advance(19_000);
    expect(pane().dataset.status).toBe("loading");
    await advance(1_000);
    expect(pane().dataset.status).toBe("error");
    expect(host!.querySelector('[role="status"]')).toBeNull();
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();
    expect(host!.querySelector("iframe")).toBeNull();
    // the seat is released (once by the removal, and again by the unmount that follows; the server's leave is idempotent)
    expect(transport.left).toBeGreaterThanOrEqual(1);

    // Tentar de novo mounts a new frame and starts over
    expect(retry()).toBeTruthy();
    act(() => retry()!.click());
    await advance(10);
    expect(pane().dataset.status).toBe("loading");
    expect(host!.querySelector("iframe")).not.toBeNull();
  });

  it("goes to the error at once when the apps origin answers the entry with a 404", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    probe.answer = { kind: "missing", status: 404 };
    render();
    await advance(10);
    expect(probe.asked).toEqual([ENTRY]);
    expect(pane().dataset.status).toBe("error");
    expect(host!.querySelector("iframe")).toBeNull();
    expect(host!.querySelector('[role="alert"]')?.textContent).toMatch(
      /Os apps não estão disponíveis aqui agora|Apps are not available here right now/,
    );
    expect(retry()).toBeTruthy();

    // the version came back: Tentar de novo asks again and frames it
    probe.answer = { kind: "ok" };
    act(() => retry()!.click());
    await advance(10);
    expect(probe.asked).toEqual([ENTRY, ENTRY]);
    expect(pane().dataset.status).toBe("loading");
    expect(host!.querySelector("iframe")).not.toBeNull();
  });
});
