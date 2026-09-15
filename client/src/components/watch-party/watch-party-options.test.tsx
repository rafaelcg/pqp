// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WATCH_PARTY_DEFAULT_OPTIONS, type WatchPartyOptions } from "@pqp/shared";
import { WatchPartyOptionsPanel } from "./watch-party-options";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * CONVIDADOS REPLACED "VOZ" (`docs/plans/WATCH_PARTY_GUESTS.md` §2). The old
 * Voz select and its one-line summary are gone from this panel; the radio
 * group in `guests/watch-party-guests-setting.tsx` is mounted in their place,
 * and this suite now pins the panel's own responsibilities: which of the
 * three options is checked, and that the busy-room slow-mode nudge (a
 * DIFFERENT row, unrelated to guests) still appears.
 */
describe("the Convidados row", () => {
  const render = (options: WatchPartyOptions, audienceCount = 0) =>
    renderToStaticMarkup(
      <WatchPartyOptionsPanel
        options={options}
        audienceCount={audienceCount}
        onChange={() => {}}
      />,
    );

  it("checks Off by default", () => {
    const html = render(WATCH_PARTY_DEFAULT_OPTIONS);
    expect(html).toContain('data-watch-party-guests-option="off"');
    const offIndex = html.indexOf('data-watch-party-guests-option="off"');
    const offInput = html.slice(offIndex, html.indexOf("<input", offIndex) + 200);
    expect(offInput).toContain("checked=\"\"");
  });

  it("checks Request when guests is request", () => {
    const html = render({ ...WATCH_PARTY_DEFAULT_OPTIONS, guests: "request" });
    const requestIndex = html.indexOf(
      'data-watch-party-guests-option="request"',
    );
    const requestInput = html.slice(
      requestIndex,
      html.indexOf("<input", requestIndex) + 200,
    );
    expect(requestInput).toContain("checked=\"\"");
  });

  it("renders all three radios, every time", () => {
    const html = render(WATCH_PARTY_DEFAULT_OPTIONS);
    expect(html).toContain('data-watch-party-guests-option="off"');
    expect(html).toContain('data-watch-party-guests-option="invite"');
    expect(html).toContain('data-watch-party-guests-option="request"');
  });
});

describe("the slow-mode nudge, unrelated to guests", () => {
  it("still shows up for a busy room whatever guests is set to", () => {
    const html = renderToStaticMarkup(
      <WatchPartyOptionsPanel
        options={{ ...WATCH_PARTY_DEFAULT_OPTIONS, guests: "off" }}
        audienceCount={30}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("already holds the flood back");
  });
});

/**
 * "BAIXA LATÊNCIA (BETA)" IS HOST-ONLY AND DEPLOYMENT-GATED
 * (`docs/plans/LL_HLS.md` §6). The row must stay out of a co-host's copy of
 * the panel (the request only ever reaches the server through the host's own
 * `goLive`) and out of any deployment `GET /api/live-hls/config` did not say
 * yes to (`lowLatencyAvailable`) -- neither is a case of disabling the row,
 * both are cases of it not existing at all, same as the deployment-gated
 * `micArchive`/`voiceTrack` rows elsewhere in this panel's family.
 */
describe("the low-latency switch: visibility", () => {
  const render = (props: Partial<Parameters<typeof WatchPartyOptionsPanel>[0]>) =>
    renderToStaticMarkup(
      <WatchPartyOptionsPanel
        options={WATCH_PARTY_DEFAULT_OPTIONS}
        audienceCount={0}
        onChange={() => {}}
        {...props}
      />,
    );

  it("is absent when the deployment has not turned LL-HLS on for this server", () => {
    const html = render({ isHost: true, lowLatencyAvailable: false });
    expect(html).not.toContain("data-watch-party-low-latency");
  });

  it("is absent for a co-host even when the deployment says yes", () => {
    const html = render({ isHost: false, lowLatencyAvailable: true });
    expect(html).not.toContain("data-watch-party-low-latency");
  });

  it("appears for the host once the deployment says yes", () => {
    const html = render({ isHost: true, lowLatencyAvailable: true });
    expect(html).toContain("data-watch-party-low-latency");
    expect(html).toContain("Low latency (beta)");
  });

  it("checks the switch to the party's own saved preference", () => {
    const on = render({
      isHost: true,
      lowLatencyAvailable: true,
      options: { ...WATCH_PARTY_DEFAULT_OPTIONS, lowLatency: true },
    });
    const rowIndex = on.indexOf("data-watch-party-low-latency");
    const row = on.slice(rowIndex, on.indexOf('role="switch"', rowIndex) + 200);
    expect(row).toContain('aria-checked="true"');

    const off = render({ isHost: true, lowLatencyAvailable: true });
    const offIndex = off.indexOf("data-watch-party-low-latency");
    const offRow = off.slice(offIndex, off.indexOf('role="switch"', offIndex) + 200);
    expect(offRow).toContain('aria-checked="false"');
  });

  it("adds the next-broadcast note only while the party is live", () => {
    const draft = render({ isHost: true, lowLatencyAvailable: true, live: false });
    expect(draft).not.toContain("Takes effect starting with the next broadcast");

    const liveHtml = render({ isHost: true, lowLatencyAvailable: true, live: true });
    expect(liveHtml).toContain("Takes effect starting with the next broadcast");
  });
});

describe("the low-latency switch: the mutation payload", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    host?.remove();
    root = null;
    host = null;
  });

  it("patches exactly { lowLatency: <the new value> }, nothing else", () => {
    const onChange = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <WatchPartyOptionsPanel
          options={WATCH_PARTY_DEFAULT_OPTIONS}
          audienceCount={0}
          onChange={onChange}
          isHost
          lowLatencyAvailable
        />,
      );
    });
    const button = host.querySelector(
      '[data-watch-party-low-latency] button[role="switch"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-checked")).toBe("false");

    act(() => {
      button?.click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ lowLatency: true });
  });
});
