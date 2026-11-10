// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JamCoverPhoto, useJamCover, type JamCoverState } from "./jam-cover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let latest: JamCoverState;

function Probe({ url }: { url: string | null }) {
  const cover = useJamCover(url);
  latest = cover;
  return <JamCoverPhoto cover={cover} />;
}

const signed = (path: string, signature: string) => `https://bucket.test/jam/${path}?X-Amz-Signature=${signature}`;
const src = () => host.querySelector("img")?.getAttribute("src") ?? null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a song's cover, signed anew on every read", () => {
  it("draws nothing for a song with none", () => {
    act(() => root.render(<Probe url={null} />));
    expect(host.querySelector("img")).toBeNull();
    expect(latest.status).toBe("none");
  });

  it("keeps the address it already drew while the picture is the same one, so a new signature never reloads it", () => {
    act(() => root.render(<Probe url={signed("s/a.jpg", "one")} />));
    expect(src()).toBe(signed("s/a.jpg", "one"));
    act(() => latest.onLoad());
    expect(latest.status).toBe("ready");
    // A song frame brings the same picture under a new signature.
    act(() => root.render(<Probe url={signed("s/a.jpg", "two")} />));
    expect(src()).toBe(signed("s/a.jpg", "one"));
    expect(latest.status).toBe("ready");
  });

  it("takes the new address when the picture is a different one", () => {
    act(() => root.render(<Probe url={signed("s/a.jpg", "one")} />));
    act(() => latest.onLoad());
    act(() => root.render(<Probe url={signed("s/b.jpg", "one")} />));
    expect(src()).toBe(signed("s/b.jpg", "one"));
    expect(latest.status).toBe("loading");
  });

  it("falls back when the picture does not load, and tries again with a fresher signature", () => {
    act(() => root.render(<Probe url={signed("s/a.jpg", "old")} />));
    act(() => latest.onError());
    expect(latest.status).toBe("failed");
    // A failed cover is not drawn at all: the caller falls back to the band.
    expect(host.querySelector("img")).toBeNull();
    // The same stale address again changes nothing.
    act(() => root.render(<Probe url={signed("s/a.jpg", "old")} />));
    expect(latest.status).toBe("failed");
    // A fresher one is tried.
    act(() => root.render(<Probe url={signed("s/a.jpg", "fresh")} />));
    expect(latest.status).toBe("loading");
    expect(src()).toBe(signed("s/a.jpg", "fresh"));
  });

  it("lets go of the picture when the cover is removed", () => {
    act(() => root.render(<Probe url={signed("s/a.jpg", "one")} />));
    act(() => root.render(<Probe url={null} />));
    expect(host.querySelector("img")).toBeNull();
    expect(latest.src).toBeNull();
  });

  it("is hidden until decoded, and visible as soon as it is", () => {
    act(() => root.render(<Probe url={signed("s/a.jpg", "one")} />));
    expect(host.querySelector("img")?.getAttribute("data-ready")).toBeNull();
    act(() => latest.onLoad());
    expect(host.querySelector("img")?.getAttribute("data-ready")).toBe("true");
  });
});
