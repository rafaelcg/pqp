import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, connect, PqpAppError, type PqpApp } from "./index.js";
import { FakeHost, HELLO } from "./fake-host.fixture.js";

let host: FakeHost;
let app: PqpApp;

beforeEach(async () => {
  host = new FakeHost();
  const pending = connect({ window: host.window, timeoutMs: 400 });
  host.accept();
  app = await pending;
});
afterEach(() => {
  host.close();
  vi.useRealTimers();
});

/** Runs `call`, lets the host answer its request with `answer(request)`, returns what the app got. */
async function exchange<T>(
  call: () => Promise<T>,
  answer: (request: Awaited<ReturnType<FakeHost["nextRequest"]>>) => void,
) {
  const result = call();
  answer(await host.nextRequest());
  return result;
}

async function rejection(promise: Promise<unknown>): Promise<PqpAppError> {
  try {
    await promise;
  } catch (error) {
    return error as PqpAppError;
  }
  throw new Error("expected a rejection");
}

describe("requests", () => {
  it("participants.get returns the list", async () => {
    const list = [
      { seatId: "seat-aaaaaaaaaaaaaaaa", displayName: "Bia", avatar: null, role: "player", isHost: true, connection: "present" },
    ];
    const got = await exchange(
      () => app.participants.get(),
      (r) => {
        expect(r).toEqual({ id: r.id, type: "participants.get" });
        host.respond(r.id, { participants: list });
      },
    );
    expect(got).toEqual(list);
  });

  it("state.get returns rev and value", async () => {
    const got = await exchange(
      () => app.state.get(),
      (r) => host.respond(r.id, { rev: 4, value: { n: 1 } }),
    );
    expect(got).toEqual({ rev: 4, value: { n: 1 } });
  });

  it("state.patch sends the merge patch, with baseRev only when given", async () => {
    const plain = await exchange(
      () => app.state.patch({ n: 2, old: null }),
      (r) => {
        expect(r).toMatchObject({ type: "state.patch", patch: { n: 2, old: null } });
        expect(r).not.toHaveProperty("baseRev");
        host.respond(r.id, { rev: 5 });
      },
    );
    expect(plain).toEqual({ rev: 5 });
    await exchange(
      () => app.state.patch({ n: 3 }, { baseRev: 5 }),
      (r) => {
        expect(r).toMatchObject({ baseRev: 5 });
        host.respond(r.id, { rev: 6 });
      },
    );
  });

  it("state.patch surfaces stale-rev as a PqpAppError with the code", async () => {
    const failure = exchange(
      () => app.state.patch({ n: 3 }, { baseRev: 1 }),
      (r) => host.fail(r.id, "stale-rev"),
    );
    const error = await rejection(failure);
    expect(error).toBeInstanceOf(PqpAppError);
    expect(error.code).toBe("stale-rev");
  });

  it("events.send resolves to null and sends name and data (null by default)", async () => {
    const got = await exchange(
      () => app.events.send("ping", { x: 1 }),
      (r) => {
        expect(r).toMatchObject({ type: "events.send", name: "ping", data: { x: 1 } });
        host.respond(r.id, null);
      },
    );
    expect(got).toBeNull();
    await exchange(
      () => app.events.send("ping"),
      (r) => {
        expect(r).toMatchObject({ name: "ping", data: null });
        host.respond(r.id, null);
      },
    );
  });

  it("assets.get returns the transferred bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const got = await exchange(
      () => app.assets.get("core.wasm"),
      (r) => {
        expect(r).toMatchObject({ type: "assets.get", name: "core.wasm" });
        host.respond(r.id, { name: "core.wasm", bytes }, [bytes]);
      },
    );
    expect(Array.from(new Uint8Array(got))).toEqual([1, 2, 3]);
  });

  it("files.pickLocal returns bytes and the extension, and null on cancel", async () => {
    const bytes = new Uint8Array([9]).buffer;
    const got = await exchange(
      () => app.files.pickLocal(),
      (r) => host.respond(r.id, { bytes, ext: ".gba" }, [bytes]),
    );
    expect(got?.ext).toBe(".gba");
    expect(Array.from(new Uint8Array(got!.bytes))).toEqual([9]);
    expect(got).not.toHaveProperty("name");

    const cancelled = await exchange(
      () => app.files.pickLocal(),
      (r) => host.fail(r.id, "cancelled"),
    );
    expect(cancelled).toBeNull();

    const refused = exchange(
      () => app.files.pickLocal(),
      (r) => host.fail(r.id, "not-allowed"),
    );
    expect((await rejection(refused)).code).toBe("not-allowed");
  });

  it("store.get returns the bytes and the meta, and null for a key with nothing", async () => {
    const bytes = new Uint8Array([7, 8]).buffer;
    const got = await exchange(
      () => app.store.get("rom:abc"),
      (r) => {
        expect(r).toEqual({ id: r.id, type: "store.get", key: "rom:abc" });
        host.respond(r.id, { bytes, meta: { n: 1 } }, [bytes]);
      },
    );
    expect(Array.from(new Uint8Array(got!.bytes))).toEqual([7, 8]);
    expect(got!.meta).toEqual({ n: 1 });

    expect(
      await exchange(
        () => app.store.get("rom:none"),
        (r) => host.respond(r.id, null),
      ),
    ).toBeNull();
  });

  it("store.put sends a copy of the bytes, a view as its own buffer, and returns the usage", async () => {
    const mine = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = mine.subarray(2, 5);
    const usage = await exchange(
      () => app.store.put("sram:abc", view, { slot: 1 }),
      (r) => {
        expect(r).toMatchObject({ type: "store.put", key: "sram:abc", meta: { slot: 1 } });
        expect(Array.from(new Uint8Array(r.bytes as ArrayBuffer))).toEqual([3, 4, 5]);
        expect((r.bytes as ArrayBuffer).byteLength).toBe(3);
        host.respond(r.id, { usage: { used: 3, cap: 512, persisted: false } });
      },
    );
    expect(usage).toEqual({ used: 3, cap: 512, persisted: false });
    // the caller's buffer was not detached
    expect(mine.byteLength).toBe(6);

    const whole = new Uint8Array([9]).buffer;
    await exchange(
      () => app.store.put("prefs", whole),
      (r) => {
        expect(r).not.toHaveProperty("meta");
        host.respond(r.id, { usage: { used: 1, cap: 512, persisted: true } });
      },
    );
    expect(whole.byteLength).toBe(1);
  });

  it("store.put rejects with too-large, store calls with not-allowed and invalid, as the host says", async () => {
    const big = exchange(
      () => app.store.put("rom:x", new ArrayBuffer(1)),
      (r) => host.fail(r.id, "too-large"),
    );
    expect((await rejection(big)).code).toBe("too-large");
    const closed = exchange(
      () => app.store.usage(),
      (r) => host.fail(r.id, "not-allowed"),
    );
    expect((await rejection(closed)).code).toBe("not-allowed");
    const old = exchange(
      () => app.store.list(),
      (r) => host.fail(r.id, "invalid"),
    );
    expect((await rejection(old)).code).toBe("invalid");
  });

  it("store.delete resolves to null, and refuses a reply that is not null", async () => {
    expect(
      await exchange(
        () => app.store.delete("rom:abc"),
        (r) => {
          expect(r).toEqual({ id: r.id, type: "store.delete", key: "rom:abc" });
          host.respond(r.id, null);
        },
      ),
    ).toBeNull();
    const odd = exchange(
      () => app.store.delete("rom:abc"),
      (r) => host.respond(r.id, { ok: 1 }),
    );
    expect((await rejection(odd)).code).toBe("unavailable");
  });

  it("store.list sends a prefix (empty by default) and returns the entries", async () => {
    const entries = [{ key: "state:abc:1", size: 10, meta: null, updatedAt: 1700 }];
    expect(
      await exchange(
        () => app.store.list("state:abc:"),
        (r) => {
          expect(r).toMatchObject({ type: "store.list", prefix: "state:abc:" });
          host.respond(r.id, entries);
        },
      ),
    ).toEqual(entries);
    await exchange(
      () => app.store.list(),
      (r) => {
        expect(r).toMatchObject({ prefix: "" });
        host.respond(r.id, []);
      },
    );
    const bad = exchange(
      () => app.store.list(),
      (r) => host.respond(r.id, { entries: [] }),
    );
    expect((await rejection(bad)).code).toBe("unavailable");
  });

  it("store.usage returns used, cap and persisted", async () => {
    expect(
      await exchange(
        () => app.store.usage(),
        (r) => host.respond(r.id, { used: 5, cap: 100, persisted: true }),
      ),
    ).toEqual({ used: 5, cap: 100, persisted: true });
  });

  it("files.saveLocal sends the bytes and the extension and resolves to null", async () => {
    const out = await exchange(
      () => app.files.saveLocal(new Uint8Array([4, 5]), ".locadora"),
      (r) => {
        expect(r).toMatchObject({ type: "files.saveLocal", ext: ".locadora" });
        expect(Array.from(new Uint8Array(r.bytes as ArrayBuffer))).toEqual([4, 5]);
        expect(r).not.toHaveProperty("name");
        host.respond(r.id, null);
      },
    );
    expect(out).toBeNull();
    const refused = exchange(
      () => app.files.saveLocal(new ArrayBuffer(1), ".zip"),
      (r) => host.fail(r.id, "not-allowed"),
    );
    expect((await rejection(refused)).code).toBe("not-allowed");
  });

  it("ui.resize, ui.fullscreen and share.request answer with what the host applied", async () => {
    expect(
      await exchange(
        () => app.ui.resize(300),
        (r) => {
          expect(r).toMatchObject({ type: "ui.resize", height: 300 });
          host.respond(r.id, { height: 300 });
        },
      ),
    ).toBe(300);
    expect(
      await exchange(
        () => app.ui.fullscreen(true),
        (r) => {
          expect(r).toMatchObject({ type: "ui.fullscreen", on: true });
          host.respond(r.id, { on: true });
        },
      ),
    ).toBe(true);
    expect(
      await exchange(
        () => app.share.request(false),
        (r) => {
          expect(r).toMatchObject({ type: "share.request", on: false });
          host.respond(r.id, { on: false });
        },
      ),
    ).toBe(false);
  });

  it("end() resolves to null", async () => {
    expect(
      await exchange(
        () => app.end(),
        (r) => {
          expect(r.type).toBe("session.end");
          host.respond(r.id, null);
        },
      ),
    ).toBeNull();
  });

  it("an error code the SDK does not know becomes unavailable", async () => {
    const error = await rejection(
      exchange(
        () => app.state.get(),
        (r) => host.fail(r.id, "something-new"),
      ),
    );
    expect(error.code).toBe("unavailable");
  });

  it("a reply without the expected field rejects instead of resolving undefined", async () => {
    const error = await rejection(
      exchange(
        () => app.state.get(),
        (r) => host.respond(r.id, { nope: true }),
      ),
    );
    expect(error.code).toBe("unavailable");
  });

  it("refuses a success that echoes another call's type, or none, and a null-result call answered with a value", async () => {
    const wrongType = await rejection(
      exchange(
        () => app.state.patch({ n: 1 }),
        (r) => host.respond(r.id, { rev: 3, value: null }, [], "state.get"),
      ),
    );
    expect(wrongType.code).toBe("unavailable");
    const noType = await rejection(
      exchange(
        () => app.state.patch({ n: 1 }),
        (r) => host.respond(r.id, { rev: 3 }, [], null),
      ),
    );
    expect(noType.code).toBe("unavailable");
    const sendWithValue = await rejection(
      exchange(
        () => app.events.send("ping", 1),
        (r) => host.respond(r.id, { ok: 1 }),
      ),
    );
    expect(sendWithValue.code).toBe("unavailable");
    const endWithValue = await rejection(
      exchange(
        () => app.end(),
        (r) => host.respond(r.id, {}),
      ),
    );
    expect(endWithValue.code).toBe("unavailable");
  });

  it("refuses a field of the wrong kind", async () => {
    const error = await rejection(
      exchange(
        () => app.state.patch({ n: 1 }),
        (r) => host.respond(r.id, { rev: "3" }),
      ),
    );
    expect(error.code).toBe("unavailable");
    const flag = await rejection(
      exchange(
        () => app.ui.fullscreen(true),
        (r) => host.respond(r.id, { on: "yes" }),
      ),
    );
    expect(flag.code).toBe("unavailable");
  });

  it("gives every request its own id of at most 32 characters", async () => {
    const a = app.state.get();
    const b = app.state.get();
    const first = await host.nextRequest();
    const second = await host.nextRequest();
    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThan(0);
    expect(second.id.length).toBeLessThanOrEqual(32);
    host.respond(second.id, { rev: 2, value: null });
    host.respond(first.id, { rev: 1, value: null });
    expect((await a).rev).toBe(1);
    expect((await b).rev).toBe(2);
  });

  it("rejects with unavailable after the request timeout, and ignores a late answer", async () => {
    vi.useFakeTimers();
    const failure = rejection(app.state.get());
    const request = await host.nextRequest();
    vi.advanceTimersByTime(400);
    expect((await failure).code).toBe("unavailable");
    vi.useRealTimers();
    host.respond(request.id, { rev: 1, value: null });
    await host.settle();
  });

  it("rejects with invalid when the value cannot be sent", async () => {
    const error = await rejection(app.state.patch((() => 1) as never));
    expect(error.code).toBe("invalid");
  });
});

describe("pushes", () => {
  it("participants.on and state.on deliver the pushed values, and unsubscribe stops them", async () => {
    const participants = vi.fn();
    const state = vi.fn();
    const stop = app.participants.on(participants);
    app.state.on(state);
    host.push({ type: "participants", participants: [] });
    host.push({ type: "state", rev: 7, value: { a: 1 } });
    await host.settle();
    expect(participants).toHaveBeenCalledWith([]);
    expect(state).toHaveBeenCalledWith({ rev: 7, value: { a: 1 } });
    stop();
    host.push({ type: "participants", participants: [] });
    await host.settle();
    expect(participants).toHaveBeenCalledTimes(1);
  });

  it("events.on only hears its own name", async () => {
    const pings = vi.fn();
    const others = vi.fn();
    app.events.on("ping", pings);
    app.events.on("other", others);
    host.push({ type: "event", fromSeatId: "seat-bbbbbbbbbbbbbbbb", name: "ping", data: { who: "Bia" } });
    await host.settle();
    expect(pings).toHaveBeenCalledWith({
      fromSeatId: "seat-bbbbbbbbbbbbbbbb",
      name: "ping",
      data: { who: "Bia" },
    });
    expect(others).not.toHaveBeenCalled();
  });

  it("on('connection') and app.connection follow the host", async () => {
    const seen = vi.fn();
    app.on("connection", seen);
    host.push({ type: "connection", status: "reconnecting" });
    await host.settle();
    expect(seen).toHaveBeenCalledWith("reconnecting");
    expect(app.connection).toBe("reconnecting");
    host.push({ type: "connection", status: "online" });
    await host.settle();
    expect(app.connection).toBe("online");
  });

  it("on('theme') delivers the tokens", async () => {
    const seen = vi.fn();
    app.on("theme", seen);
    host.push({ type: "theme", theme: { "--bg": "#fff" } });
    await host.settle();
    expect(seen).toHaveBeenCalledWith({ "--bg": "#fff" });
  });

  it("on('ended') delivers the reason, and every later call rejects with ended", async () => {
    const seen = vi.fn();
    app.on("ended", seen);
    host.push({ type: "session.ended", reason: "host" });
    await host.settle();
    expect(seen).toHaveBeenCalledWith("host");
    expect((await rejection(app.state.get())).code).toBe("ended");
    expect((await rejection(app.end())).code).toBe("ended");
    expect(host.requests).toEqual([]);
  });

  it("a listener that throws does not stop the next one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    app.on("theme", () => {
      throw new Error("boom");
    });
    app.on("theme", after);
    host.push({ type: "theme", theme: {} });
    await host.settle();
    expect(after).toHaveBeenCalled();
    error.mockRestore();
  });

  it("ignores pushes it does not know and garbage on the port", async () => {
    const seen = vi.fn();
    app.on("theme", seen);
    host.push({ type: "from-the-future", x: 1 });
    host.push("hello");
    host.push(null);
    host.push({ type: "theme", theme: {} });
    await host.settle();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("applyTheme", () => {
  it("sets each token as a custom property on the root", () => {
    const set: Record<string, string> = {};
    applyTheme({ "--bg": "#111", "--fg": "#eee" }, { style: { setProperty: (n, v) => (set[n] = v) } });
    expect(set).toEqual({ "--bg": "#111", "--fg": "#eee" });
    expect(HELLO.theme["--bg"]).toBe("#111111");
  });
});

describe("package hygiene", () => {
  it("imports nothing but its own files: no dependency, runtime or type", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const sources = readdirSync(dir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".fixture.ts"),
    );
    expect(sources.length).toBeGreaterThan(3);
    for (const name of sources) {
      const text = readFileSync(dir + name, "utf8");
      const imports = [...text.matchAll(/^(?:import|export)\b[^;]*?from\s+"([^"]+)"/gms)];
      for (const match of imports) {
        const spec = match[1]!;
        expect(spec.startsWith("./"), `${name} imports ${spec}`).toBe(true);
      }
    }
    const pkg = JSON.parse(readFileSync(dir + "../package.json", "utf8"));
    expect(pkg.dependencies).toBeUndefined();
  });
});
