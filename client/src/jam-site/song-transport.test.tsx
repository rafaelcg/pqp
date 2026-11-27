// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadJamLocale } from "@/lib/i18n/jam-site";
import type { PlayerState, PublicPlayer } from "./player";
import { SongTransport } from "./song-transport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await loadJamLocale("pt-BR");
});

const STATE: PlayerState = { phase: "ready", playing: false, durationMs: 28000, solo: null, stemsReady: true, bytes: null };

function fakePlayer(): PublicPlayer {
  return {
    getState: () => STATE,
    subscribe: () => () => undefined,
    position: () => 0,
    onFrame: () => () => undefined,
    toggle: vi.fn(),
    seek: vi.fn(),
    setSolo: vi.fn(),
    attachVideo: () => () => undefined,
    dispose: vi.fn(),
  };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(needs: Array<"drums" | "vocals" | "bass" | "guitar" | "keys" | "other">, onRecord = vi.fn()) {
  act(() =>
    root.render(
      <SongTransport player={fakePlayer()} likes={0} needs={needs} onLike={() => undefined} onShare={() => undefined} onRecord={onRecord} />,
    ),
  );
  return onRecord;
}

describe("every instrument a song asks for is a choice on the first screen (round 3, n-8)", () => {
  it("one need: the one record button, as before, and no list of others", () => {
    mount(["bass"]);
    expect(host.querySelector("[data-jam-record]")?.textContent).toContain("Gravar o baixo");
    expect(host.querySelector("[data-jam-record-others]")).toBeNull();
  });

  it("several: the first is the main button and each of the others has a button of its own", () => {
    const onRecord = mount(["drums", "vocals", "keys"]);
    expect(host.querySelector("[data-jam-record]")?.textContent).toContain("Gravar a bateria");
    const others = [...host.querySelectorAll<HTMLButtonElement>("[data-jam-record-alt]")];
    expect(others.map((one) => one.dataset.jamRecordAlt)).toEqual(["vocals", "keys"]);
    expect(others.map((one) => one.getAttribute("aria-label"))).toEqual(["Gravar a voz", "Gravar o teclado"]);
    act(() => others[0]!.click());
    expect(onRecord).toHaveBeenLastCalledWith("vocals");
    act(() => host.querySelector<HTMLButtonElement>("[data-jam-record]")!.click());
    expect(onRecord).toHaveBeenLastCalledWith("drums");
  });

  it("a song with nothing named still offers one button for any part, and a closed song none", () => {
    mount([]);
    expect(host.querySelector("[data-jam-record]")?.textContent).toContain("Gravar tua parte");
    act(() =>
      root.render(
        <SongTransport player={fakePlayer()} likes={0} needs={[]} onLike={() => undefined} onShare={() => undefined} onRecord={null} />,
      ),
    );
    expect(host.querySelector("[data-jam-record]")).toBeNull();
  });
});
