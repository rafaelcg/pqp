// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { JamPublicMineResponse, JamPublicMyPart } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  mine: vi.fn(),
  parts: vi.fn(),
}));
vi.mock("@/lib/jam-public-api", () => ({
  fetchJamPublicMine: api.mine,
  fetchJamPublicMyParts: api.parts,
  // The rest of the module is not used by this view.
  fetchJamPublicConsents: vi.fn(() => Promise.resolve({ pending: [] })),
  fetchJamPublicInbox: vi.fn(() => Promise.resolve({ takes: [] })),
  fetchJamTakeNotices: vi.fn(() => Promise.resolve({ notices: [] })),
}));

import { peekPublicJamRequest } from "@/lib/jam-public-nav";
import { JamMineView } from "./jam-mine-view";

const SONG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const part = (over: Partial<JamPublicMyPart>): JamPublicMyPart => ({
  trackId: "t",
  songId: OTHER,
  title: "Lua cheia",
  instrument: "guitar",
  state: "waiting",
  startedBy: "Ana",
  sentAt: "2026-11-26T12:00:00.000Z",
  answeredAt: null,
  ...over,
});

const started = (title: string): JamPublicMineResponse["songs"][number] =>
  ({
    song: { id: SONG, title, coverUrl: null },
    publication: { status: "live" },
  }) as unknown as JamPublicMineResponse["songs"][number];

let host: HTMLDivElement;
let root: Root;

async function mount(onClose = vi.fn()) {
  await act(async () => {
    root.render(
      <I18nProvider>
        <JamMineView onClose={onClose} />
      </I18nProvider>,
    );
  });
  // let the two reads settle
  await act(async () => {
    await Promise.resolve();
  });
  return onClose;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  api.mine.mockReset();
  api.parts.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Tuas músicas (round 3, N-3)", () => {
  it("lists what I started and what I sent, each part with its state, open ones first", async () => {
    api.mine.mockResolvedValue({ songs: [started("Garoa em Pelotas")] });
    api.parts.mockResolvedValue({
      parts: [
        part({ trackId: "r", state: "refused", title: "Minuano", startedBy: "Leco" }),
        part({ trackId: "w", state: "waiting", title: "Lua cheia", startedBy: "Ana" }),
        part({ trackId: "i", state: "in", title: "Café sem açúcar", startedBy: "Cris" }),
      ],
    });
    await mount();
    expect(host.querySelector("[data-jam-mine-started]")?.textContent).toContain("Garoa em Pelotas");
    const states = [...host.querySelectorAll<HTMLElement>("[data-jam-mine-part]")].map((row) => [
      row.dataset.state,
      row.querySelector("[data-jam-mine-state]")?.textContent,
    ]);
    // The view puts what still waits first, then what went in, then refusals (the catalogue is English in a test run).
    expect(states.map(([state]) => state)).toEqual(["waiting", "in", "refused"]);
    expect(states[0]![1]).toContain("Waiting for Ana to answer");
    expect(states[1]![1]).toContain("It is in the song");
    expect(states[2]![1]).toContain("Leco did not put it in the song");
  });

  it("a part opens its song", async () => {
    api.mine.mockResolvedValue({ songs: [] });
    api.parts.mockResolvedValue({ parts: [part({ trackId: "w", songId: OTHER })] });
    await mount();
    act(() => host.querySelector<HTMLButtonElement>("[data-jam-mine-part]")!.click());
    expect(peekPublicJamRequest()?.target).toBe(OTHER);
  });

  it("with nothing yet it says so and offers to start one", async () => {
    api.mine.mockResolvedValue({ songs: [] });
    api.parts.mockResolvedValue({ parts: [] });
    await mount();
    expect(host.querySelector("[data-jam-mine-empty]")).not.toBeNull();
    expect(host.querySelector("[data-jam-mine-started]")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>("[data-jam-mine-empty] button")!.click());
    expect(peekPublicJamRequest()?.target).toBe("new");
  });

  it("a failed read says so and can try again", async () => {
    api.mine.mockRejectedValue(new Error("offline"));
    api.parts.mockRejectedValue(new Error("offline"));
    await mount();
    expect(host.querySelector("[data-jam-mine-error]")).not.toBeNull();
    api.mine.mockResolvedValue({ songs: [started("Garoa em Pelotas")] });
    api.parts.mockResolvedValue({ parts: [] });
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-jam-mine-error] button")!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector("[data-jam-mine-started]")).not.toBeNull();
  });

  it("has its own way back to the site and a back arrow, so nobody is left in the chat product with no door", async () => {
    api.mine.mockResolvedValue({ songs: [] });
    api.parts.mockResolvedValue({ parts: [] });
    const onClose = await mount();
    const site = host.querySelector<HTMLAnchorElement>("[data-jam-mine-site]")!;
    expect(site.getAttribute("href")).toMatch(/\/jam\?signed=1|jam\.pqp\.gg/);
    act(() => host.querySelector<HTMLButtonElement>("[data-jam-mine-back]")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
