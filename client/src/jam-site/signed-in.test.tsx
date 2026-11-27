// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JAM_SIGNED_IN_KEY } from "@/lib/jam-signed-in";

const went = vi.hoisted(() => [] as string[]);
vi.mock("./go", () => ({ go: (href: string) => void went.push(href) }));

import { AskProvider, useAsk } from "./auth-sheet";
import { Header } from "./shell";
import { loadJamLocale } from "@/lib/i18n/jam-site";

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

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  went.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/jam");
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Opener() {
  const ask = useAsk();
  return (
    <>
      <button type="button" data-opener="record" onClick={() => ask({ kind: "record", songId: "11111111-1111-4111-8111-111111111111", instrument: "bass" })}>
        record
      </button>
      <button type="button" data-opener="start" onClick={() => ask({ kind: "start" })}>
        start
      </button>
    </>
  );
}

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AskProvider>
        <Header />
        <Opener />
      </AskProvider>,
    ),
  );
  return {
    dialog: () => host!.querySelector<HTMLDialogElement>("dialog[data-jam-sheet]")!,
    press: (kind: string) => act(() => host!.querySelector<HTMLButtonElement>(`[data-opener="${kind}"]`)!.click()),
  };
}

function signIn(name: string | null) {
  localStorage.setItem(JAM_SIGNED_IN_KEY, JSON.stringify({ value: name ? `1.${name}` : "1", at: Date.now() }));
}

describe("a signed-out visitor", () => {
  it("sees Entrar, and record opens the sheet instead of leaving", () => {
    const { dialog, press } = mount();
    const entrar = host!.querySelector<HTMLAnchorElement>("[data-jam-signin]");
    expect(entrar?.textContent).toBe("Entrar");
    // not hidden at any width: there is no `hidden` utility on it
    expect(entrar?.className).not.toMatch(/(^|\s)(max-sm:)?hidden(\s|$)/);
    expect(host!.querySelector("[data-jam-account]")).toBeNull();
    press("record");
    expect(dialog().open).toBe(true);
    expect(went).toEqual([]);
  });
});

describe("a visitor the app says is signed in", () => {
  it("sees their initial and \"Tuas músicas\" where Entrar was, linking to that list in the app (round 3, N-3)", () => {
    signIn("Rafa");
    mount();
    expect(host!.querySelector("[data-jam-signin]")).toBeNull();
    const account = host!.querySelector<HTMLAnchorElement>("[data-jam-account]")!;
    expect(account.textContent).toContain("Tuas músicas");
    expect(account.querySelector("[aria-hidden]")?.textContent).toBe("R");
    expect(account.getAttribute("href")).toBe("/app?jam=mine");
    expect(account.getAttribute("aria-label")).toBe("Tuas músicas");
    // The name is still there for anyone who hovers the chip.
    expect(account.getAttribute("title")).toBe("Rafa · Tuas músicas");
  });

  it("draws a glyph, not a blank, when the hint has no name", () => {
    signIn(null);
    mount();
    const account = host!.querySelector<HTMLAnchorElement>("[data-jam-account]")!;
    expect(account.querySelector("svg")).not.toBeNull();
  });

  it("goes straight to the app on record, with the song and the instrument, and no sheet", () => {
    signIn("Rafa");
    const { dialog, press } = mount();
    press("record");
    expect(dialog().open).toBe(false);
    expect(went).toHaveLength(1);
    expect(went[0]).toContain("/app?jam=11111111-1111-4111-8111-111111111111&record=1&instrument=bass");
  });

  it("goes straight to the app to start a song", () => {
    signIn("Rafa");
    const { dialog, press } = mount();
    press("start");
    expect(dialog().open).toBe(false);
    expect(went[0]).toContain("/app?jam=new");
  });
});
