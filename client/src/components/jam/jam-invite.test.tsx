// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { JamInviteCard, type JamInviteSubject } from "./jam-invite";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";
const wanted: JamInviteSubject = {
  id: ID,
  title: "Maré baixa",
  coverUrl: null,
  artist: null,
  joinMode: "wanted",
  wantedInstruments: ["bass", "drums"],
  instruments: ["vocals", "drums"],
};

let host: HTMLDivElement;
let root: Root;
const calls: Array<[string, unknown]> = [];

function mount(subject: JamInviteSubject, props: Partial<Parameters<typeof JamInviteCard>[0]> = {}) {
  act(() => {
    root.render(
      <I18nProvider>
        <JamInviteCard subject={subject} surface="created" {...props} />
      </I18nProvider>,
    );
  });
}

function click(selector: string) {
  const element = host.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  act(() => {
    element!.click();
  });
}

beforeEach(() => {
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  (window as unknown as { umami?: unknown }).umami = { track: (name: string, data?: unknown) => void calls.push([name, data]) };
  // Replace whatever the rig left: the card must work with and without a Web Share API.
  Object.defineProperty(navigator, "share", { value: undefined, configurable: true, writable: true });
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true, writable: true });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { umami?: unknown }).umami;
});

describe("JamInviteCard on a desktop (no Web Share API)", () => {
  it("shows the song, the prepared message and the public link with ref=share", () => {
    mount(wanted, { justSent: "vocals" });
    const text = host.textContent ?? "";
    expect(text).toContain("Maré baixa");
    expect(text).toContain("it needs bass");
    expect(text).toContain("Record your part:");
    const link = host.querySelector("[data-jam-invite-link]")!.textContent!;
    expect(link).toContain(`/jam/m/${ID}?ref=share`);
    expect(link).not.toContain("/app");
  });

  it("copy is the primary action and WhatsApp, X and Telegram are plain links with the message in them", () => {
    mount(wanted);
    expect(host.querySelector("[data-jam-invite-share]")).toBeNull();
    expect(host.querySelector("[data-jam-invite-copy]")).not.toBeNull();
    const hrefs = Object.fromEntries(
      [...host.querySelectorAll<HTMLAnchorElement>("[data-jam-invite-network]")].map((a) => [a.dataset.jamInviteNetwork, a.href]),
    );
    expect(Object.keys(hrefs)).toEqual(["whatsapp", "x", "telegram"]);
    expect(hrefs.whatsapp).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(hrefs.whatsapp!)).toContain(`/jam/m/${ID}?ref=share`);
    expect(hrefs.x).toMatch(/^https:\/\/x\.com\/intent\/post\?/);
    expect(hrefs.telegram).toMatch(/^https:\/\/t\.me\/share\/url\?/);
    for (const a of host.querySelectorAll<HTMLAnchorElement>("[data-jam-invite-network]")) {
      expect(a.rel).toContain("noopener");
      expect(a.target).toBe("_blank");
    }
  });

  it("says it was shown, and which target was tapped", () => {
    mount(wanted);
    expect(calls).toEqual([["jam_share_shown", { surface: "created", kind: "needs", native: false }]]);
    click("[data-jam-invite-network='whatsapp']");
    click("[data-jam-invite-network='x']");
    click("[data-jam-invite-network='telegram']");
    click("[data-jam-invite-copy]");
    expect(calls.slice(1).map(([name, data]) => [name, (data as { target: string }).target])).toEqual([
      ["jam_share_tap", "whatsapp"],
      ["jam_share_tap", "x"],
      ["jam_share_tap", "telegram"],
      ["jam_share_tap", "copy"],
    ]);
  });

  it("a complete song invites listening instead of asking for a part", () => {
    mount({ ...wanted, wantedInstruments: ["vocals"], instruments: ["vocals"] });
    expect(host.textContent).toContain("give this jam a listen");
    expect(host.querySelector("[data-jam-invite]")!.getAttribute("data-kind")).toBe("listen");
  });

  it("leaves out the part the person just sent", () => {
    mount({ ...wanted, instruments: [] }, { justSent: "drums" });
    expect(host.textContent).toContain("it needs bass.");
    expect(host.textContent).not.toContain("bass and drums");
  });
});

describe("JamInviteCard on a phone (Web Share API)", () => {
  it("the primary opens the system sheet with the title, the message and the link, and the copy is the quiet one", async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
    mount(wanted, { justSent: "vocals" });
    expect(host.querySelector("[data-jam-invite-networks]")).toBeNull();
    expect(host.querySelector("[data-jam-invite-share]")).not.toBeNull();
    await act(async () => {
      host.querySelector<HTMLElement>("[data-jam-invite-share]")!.click();
    });
    expect(share).toHaveBeenCalledTimes(1);
    const arg = (share.mock.calls[0] as unknown as [{ title: string; text: string; url: string }])[0];
    expect(arg.title).toBe("Maré baixa");
    expect(arg.text).toBe("Maré baixa: it needs bass. Record your part:");
    expect(arg.url).toContain(`/jam/m/${ID}?ref=share`);
    expect(calls.map(([name]) => name)).toEqual(["jam_share_shown", "jam_share_tap"]);
    expect((calls[0]![1] as { native: boolean }).native).toBe(true);
    expect((calls[1]![1] as { target: string }).target).toBe("native");
  });

  it("a dismissed sheet is not an error and copies nothing", async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true, writable: true });
    Object.defineProperty(navigator, "share", {
      value: () => Promise.reject(new DOMException("dismissed", "AbortError")),
      configurable: true,
      writable: true,
    });
    mount(wanted);
    await act(async () => {
      host.querySelector<HTMLElement>("[data-jam-invite-share]")!.click();
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("a sheet that cannot open falls back to copying the link", async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true, writable: true });
    Object.defineProperty(navigator, "share", {
      value: () => Promise.reject(new DOMException("no", "NotAllowedError")),
      configurable: true,
      writable: true,
    });
    mount(wanted);
    await act(async () => {
      host.querySelector<HTMLElement>("[data-jam-invite-share]")!.click();
    });
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`/jam/m/${ID}?ref=share`));
  });
});

describe("without the hosted analytics tag", () => {
  it("is silent and never throws: no window.umami, no event", () => {
    delete (window as unknown as { umami?: unknown }).umami;
    expect(() => mount(wanted)).not.toThrow();
    click("[data-jam-invite-copy]");
    expect(calls).toEqual([]);
  });
});
