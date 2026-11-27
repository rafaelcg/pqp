// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadJamLocale } from "@/lib/i18n/jam-site";
import { coverPage, isPageCovered, usePauseWhenCovered } from "./cover";
import { Sheet } from "./ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await loadJamLocale("pt-BR");
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

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

function fakePlayer(playing: boolean) {
  const state = { playing };
  return {
    state,
    getState: () => state as never,
    toggle: vi.fn(() => {
      state.playing = !state.playing;
    }),
  };
}

function Page({ player }: { player: ReturnType<typeof fakePlayer> }) {
  usePauseWhenCovered(player);
  return null;
}

describe("a sheet covers the page (round 1 m9, still open in round 3)", () => {
  it("pauses what is playing the moment something covers the page", () => {
    const player = fakePlayer(true);
    act(() => root.render(<Page player={player} />));
    expect(player.toggle).not.toHaveBeenCalled();
    let release!: () => void;
    act(() => {
      release = coverPage();
    });
    expect(player.toggle).toHaveBeenCalledTimes(1);
    expect(player.state.playing).toBe(false);
    act(() => release());
  });

  it("leaves a song that is already paused alone, and never resumes one when the cover goes", () => {
    const player = fakePlayer(false);
    act(() => root.render(<Page player={player} />));
    let release!: () => void;
    act(() => {
      release = coverPage();
    });
    expect(player.toggle).not.toHaveBeenCalled();
    const playing = fakePlayer(true);
    act(() => root.render(<Page player={playing} />));
    expect(playing.toggle).toHaveBeenCalledTimes(1);
    act(() => release());
    expect(playing.toggle).toHaveBeenCalledTimes(1);
    expect(playing.state.playing).toBe(false);
  });

  it("counts covers: the page is covered until the last one lets go, and a release is idempotent", () => {
    let a!: () => void;
    let b!: () => void;
    act(() => {
      a = coverPage();
      b = coverPage();
    });
    expect(isPageCovered()).toBe(true);
    act(() => a());
    act(() => a());
    expect(isPageCovered()).toBe(true);
    act(() => b());
    expect(isPageCovered()).toBe(false);
  });

  it("every Sheet the site opens covers the page while it is open, and only then", () => {
    const player = fakePlayer(true);
    act(() =>
      root.render(
        <>
          <Page player={player} />
          <Sheet open={false} onClose={() => undefined} title="x">
            conteúdo
          </Sheet>
        </>,
      ),
    );
    expect(isPageCovered()).toBe(false);
    act(() =>
      root.render(
        <>
          <Page player={player} />
          <Sheet open onClose={() => undefined} title="x">
            conteúdo
          </Sheet>
        </>,
      ),
    );
    expect(isPageCovered()).toBe(true);
    expect(player.toggle).toHaveBeenCalledTimes(1);
    act(() =>
      root.render(
        <>
          <Page player={player} />
          <Sheet open={false} onClose={() => undefined} title="x">
            conteúdo
          </Sheet>
        </>,
      ),
    );
    expect(isPageCovered()).toBe(false);
  });
});
