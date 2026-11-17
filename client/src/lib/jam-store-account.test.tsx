// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { song } from "./jam-test-fixtures";

vi.mock("@/lib/jam-api", () => ({
  fetchJamSongs: vi.fn(),
  fetchJamSong: vi.fn(),
}));

import { fetchJamSongs } from "@/lib/jam-api";
import { resetJamStoreForTests, setJamViewer, useJamChannel } from "./jam-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const channelId = "22222222-2222-4222-8222-222222222222";
const list = vi.mocked(fetchJamSongs);

/** What App does: the viewer is set in the render body, then a screen below reads the store. */
function Screen({ userId, seen }: { userId: string | null; seen: string[][] }) {
  setJamViewer(userId);
  return <Wall seen={seen} />;
}

function Wall({ seen }: { seen: string[][] }) {
  const state = useJamChannel(channelId);
  seen.push(state.songs.map((s) => s.id));
  return <ul>{state.songs.map((s) => <li key={s.id}>{s.id}</li>)}</ul>;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  list.mockReset();
  resetJamStoreForTests();
  setJamViewer(null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a mounted wall when the account changes", () => {
  it("never renders the first account's songs for the second, and asks again for the second", async () => {
    const seen: string[][] = [];
    list.mockResolvedValueOnce({ songs: [song({ id: "first-songs" })], nextCursor: null });
    await act(async () => root.render(<Screen userId="first" seen={seen} />));
    expect(host.textContent).toContain("first-songs");
    expect(list).toHaveBeenCalledTimes(1);

    seen.length = 0;
    list.mockResolvedValueOnce({ songs: [song({ id: "second-songs" })], nextCursor: null });
    await act(async () => root.render(<Screen userId="second" seen={seen} />));
    // no render for the second account ever held the first account's songs
    expect(seen.some((songs) => songs.includes("first-songs"))).toBe(false);
    // the mounted wall asked again (it did not wait to be remounted)
    expect(list).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("second-songs");
    expect(host.textContent).not.toContain("first-songs");
  });

  it("reads again when the account arrives after the wall's first load began", async () => {
    // a direct link: the wall mounts while the account id is still unknown
    const seen: string[][] = [];
    list.mockResolvedValueOnce({ songs: [], nextCursor: null });
    await act(async () => root.render(<Screen userId={null} seen={seen} />));
    expect(list).toHaveBeenCalledTimes(1);

    list.mockResolvedValueOnce({ songs: [song({ id: "mine" })], nextCursor: null });
    await act(async () => root.render(<Screen userId="me" seen={seen} />));
    expect(list).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("mine");
  });
});
