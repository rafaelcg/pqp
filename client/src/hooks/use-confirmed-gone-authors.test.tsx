// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useConfirmedGoneAuthors,
  type AuthorGoneCheck,
  type MissingAuthor,
} from "./use-confirmed-gone-authors";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Refresh = () => Promise<ReadonlySet<string> | null>;

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: AuthorGoneCheck;

const NOBODY: ReadonlyMap<string, unknown> = new Map();

function deferred() {
  let resolve!: (members: ReadonlySet<string> | null) => void;
  const promise = new Promise<ReadonlySet<string> | null>((r) => (resolve = r));
  return { promise, resolve };
}

/** A fresh roster read that holds these members. */
const held = (...ids: string[]) => new Set(ids);

const miss = (authorId: string, messageId = "m1"): MissingAuthor => ({
  authorId,
  messageId,
});

function Probe({
  serverId,
  refresh,
  roster = NOBODY,
}: {
  serverId: string;
  refresh: Refresh;
  roster?: ReadonlyMap<string, unknown>;
}) {
  latest = useConfirmedGoneAuthors(serverId, refresh, roster);
  return null;
}

function mount(serverId: string, refresh: Refresh) {
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
  vi.useRealTimers();
});

describe("useConfirmedGoneAuthors", () => {
  it("confirms an author only after a read that started once they were noticed", async () => {
    const reads = [deferred()];
    let calls = 0;
    mount("s1", () => reads[calls++]!.promise);
    act(() => latest.report([miss("a")]));
    expect(calls).toBe(1);
    expect(latest.confirmed.has("a")).toBe(false);
    reads[0]!.resolve(held());
    await settle();
    expect(latest.confirmed.has("a")).toBe(true);
  });

  it("makes an author reported mid-read wait for the next read", async () => {
    const reads = [deferred(), deferred()];
    let calls = 0;
    mount("s1", () => reads[calls++]!.promise);
    act(() => latest.report([miss("a")]));
    act(() => latest.report([miss("b")]));
    expect(calls).toBe(1);
    reads[0]!.resolve(held());
    await settle();
    expect(latest.confirmed.has("a")).toBe(true);
    expect(latest.confirmed.has("b")).toBe(false);
    expect(calls).toBe(2);
    reads[1]!.resolve(held());
    await settle();
    expect(latest.confirmed.has("b")).toBe(true);
  });

  it("keeps a report made while the list mounts, before the hook's own effects run", async () => {
    let calls = 0;
    const refresh: Refresh = async () => (calls++, held());
    function Reporter({ check }: { check: AuthorGoneCheck }) {
      useEffect(() => {
        check.report([miss("a")]);
        // Mount only: this is the report the hook's own effects must not lose.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    }
    function Parent() {
      latest = useConfirmedGoneAuthors("s1", refresh, NOBODY);
      return <Reporter check={latest} />;
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Parent />));
    await settle();
    expect(calls).toBe(1);
    expect(latest.confirmed.has("a")).toBe(true);
  });

  it("confirms only the authors the fresh read still lacks", async () => {
    mount("s1", async () => held("a"));
    act(() => latest.report([miss("a"), miss("b")]));
    await settle();
    expect(latest.confirmed.has("a")).toBe(false);
    expect(latest.confirmed.has("b")).toBe(true);
  });

  it("reads again for an author the fresh read held, once they are missing again", async () => {
    let calls = 0;
    mount("s1", async () => (calls++, calls === 1 ? held("a") : held()));
    act(() => latest.report([miss("a")]));
    await settle();
    expect(latest.confirmed.has("a")).toBe(false);
    act(() => latest.report([miss("a")]));
    await settle();
    expect(calls).toBe(2);
    expect(latest.confirmed.has("a")).toBe(true);
  });

  it("reads once per author and message", async () => {
    let calls = 0;
    mount("s1", async () => (calls++, held()));
    act(() => latest.report([miss("a")]));
    await settle();
    act(() => latest.report([miss("a")]));
    await settle();
    expect(calls).toBe(1);
    expect(latest.confirmed.has("a")).toBe(true);
  });

  describe("after a failed read", () => {
    it("tries again by itself, without anyone reporting the author again", async () => {
      vi.useFakeTimers();
      const results: Array<ReadonlySet<string> | null> = [null, held()];
      let calls = 0;
      mount("s1", async () => results[calls++]!);
      act(() => latest.report([miss("a")]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(1);
      expect(latest.confirmed.size).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(calls).toBe(2);
      expect(latest.confirmed.has("a")).toBe(true);
    });

    it("gives up after three tries, and a new message starts over", async () => {
      vi.useFakeTimers();
      let calls = 0;
      mount("s1", async () => (calls++, null));
      act(() => latest.report([miss("a")]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 45_000);
      });
      expect(calls).toBe(4);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(calls).toBe(4);
      act(() => latest.report([miss("a", "m2")]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(5);
      // The fresh check fails too, and has its own retries.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(calls).toBe(6);
    });

    it("stops trying when the list goes away", async () => {
      vi.useFakeTimers();
      let calls = 0;
      mount("s1", async () => (calls++, null));
      act(() => latest.report([miss("a")]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(calls).toBe(1);
      act(() => root!.unmount());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(calls).toBe(1);
    });
  });

  describe("an author who comes back", () => {
    it("loses the confirmation when the roster holds them again", async () => {
      const second = deferred();
      const reads = [Promise.resolve(held()), second.promise];
      let calls = 0;
      const refresh: Refresh = () => reads[calls++]!;
      mount("s1", refresh);
      act(() => latest.report([miss("a")]));
      await settle();
      expect(latest.confirmed.has("a")).toBe(true);

      act(() =>
        root!.render(
          <Probe serverId="s1" refresh={refresh} roster={new Map([["a", 1]])} />,
        ),
      );
      expect(latest.confirmed.has("a")).toBe(false);

      // Gone again: the same message is a new absence, so it is read again.
      act(() => root!.render(<Probe serverId="s1" refresh={refresh} />));
      expect(calls).toBe(1);
      act(() => latest.report([miss("a")]));
      expect(calls).toBe(2);
      expect(latest.confirmed.has("a")).toBe(false);
      second.resolve(held());
      await settle();
      expect(latest.confirmed.has("a")).toBe(true);
    });

    it("loses the confirmation at once when they write something new", async () => {
      const reads = [deferred(), deferred()];
      let calls = 0;
      mount("s1", () => reads[calls++]!.promise);
      act(() => latest.report([miss("a", "m1")]));
      reads[0]!.resolve(held());
      await settle();
      expect(latest.confirmed.has("a")).toBe(true);

      act(() => latest.report([miss("a", "m2")]));
      expect(latest.confirmed.has("a")).toBe(false);
      expect(calls).toBe(2);
      reads[1]!.resolve(held());
      await settle();
      expect(latest.confirmed.has("a")).toBe(true);

      // The older message is no news: it neither reads nor un-tags.
      act(() => latest.report([miss("a", "m1")]));
      expect(latest.confirmed.has("a")).toBe(true);
      expect(calls).toBe(2);
    });

    it("is not confirmed by a read that began before their new message", async () => {
      const reads = [deferred(), deferred(), deferred()];
      let calls = 0;
      mount("s1", () => reads[calls++]!.promise);
      act(() => latest.report([miss("a", "m1")]));
      reads[0]!.resolve(held());
      await settle();
      expect(latest.confirmed.has("a")).toBe(true);

      act(() => latest.report([miss("a", "m2")]));
      expect(calls).toBe(2);
      // They rejoin and write again while that read is out.
      act(() => latest.report([miss("a", "m3")]));
      reads[1]!.resolve(held());
      await settle();
      expect(latest.confirmed.has("a")).toBe(false);
      expect(calls).toBe(3);
      reads[2]!.resolve(held());
      await settle();
      expect(latest.confirmed.has("a")).toBe(true);
    });
  });

  it("forgets everything when the server changes", async () => {
    let calls = 0;
    const refresh: Refresh = async () => (calls++, held());
    mount("s1", refresh);
    act(() => latest.report([miss("a")]));
    await settle();
    expect(latest.confirmed.has("a")).toBe(true);
    act(() => root!.render(<Probe serverId="s2" refresh={refresh} />));
    await settle();
    expect(latest.confirmed.size).toBe(0);
    act(() => latest.report([miss("a")]));
    await settle();
    expect(calls).toBe(2);
    expect(latest.confirmed.has("a")).toBe(true);
  });

  it("drops a read that lands after the server changed", async () => {
    const read = deferred();
    const refresh: Refresh = () => read.promise;
    mount("s1", refresh);
    act(() => latest.report([miss("a")]));
    act(() => root!.render(<Probe serverId="s2" refresh={refresh} />));
    read.resolve(held());
    await settle();
    expect(latest.confirmed.size).toBe(0);
  });
});
