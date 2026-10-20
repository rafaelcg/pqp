// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * THE OWNER'S APPS LIST. An owner can only switch OFF what the operator
 * released, a switch with somebody inside asks first and says how many, and a
 * refused write puts the switch back with a sentence.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const app = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  icon: "sparkles",
  category: "tool",
  names: { "pt-BR": `App ${id}`, en: `App ${id}`, es: `App ${id}` },
  descriptions: { "pt-BR": "Descrição.", en: "Description.", es: "Descripción." },
  enabled: true,
  paused: false,
  liveSessions: 0,
  ...over,
});

const state = {
  apps: [] as ReturnType<typeof app>[],
  config: { enabled: true },
  fail: false,
  /** When set, the next read waits for it (and then answers with what it resolves to). */
  hold: null as Promise<{ apps: ReturnType<typeof app>[] }> | null,
};
const fetchApps = vi.fn();
const write = vi.fn();
const fetchConfig = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchAppsEnabled: (...args: unknown[]) => {
    fetchConfig(...args);
    return Promise.resolve(state.config);
  },
  fetchServerApps: (...args: unknown[]) => {
    fetchApps(...args);
    if (state.hold) {
      const held = state.hold;
      state.hold = null;
      return held;
    }
    return state.fail ? Promise.reject(new Error("down")) : Promise.resolve({ apps: state.apps });
  },
  setServerAppOwnerSwitch: (...args: unknown[]) => write(...args),
}));

const { AppsSettingsSection, useServerAppsEnabled, appLabel } = await import(
  "./apps-settings-section"
);
const { I18nProvider } = await import("@/lib/i18n");

let host: HTMLDivElement;
let root: Root;

async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fetchApps.mockClear();
  write.mockReset();
  fetchConfig.mockClear();
  state.apps = [app("poll"), app("jogos", { liveSessions: 2 })];
  state.config = { enabled: true };
  state.fail = false;
  state.hold = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const switches = () => Array.from(host.querySelectorAll<HTMLElement>('[role="switch"]'));
const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
};

describe("the list", () => {
  it("shows each released app with a switch named after it, on", async () => {
    await mount(<AppsSettingsSection serverId="s1" />);
    expect(fetchApps).toHaveBeenCalledWith("s1");
    const all = switches();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.textContent)).toEqual([
      expect.stringContaining("App poll"),
      expect.stringContaining("App jogos"),
    ]);
    expect(all.every((s) => s.getAttribute("aria-checked") === "true")).toBe(true);
    expect(host.textContent).toContain("Released by pqp.");
  });

  it("says so when nothing was released, with no switch to press", async () => {
    state.apps = [];
    await mount(<AppsSettingsSection serverId="s1" />);
    expect(switches()).toHaveLength(0);
    expect(host.textContent).toContain("No apps here yet");
    expect(host.textContent).toContain("pqp has not released any apps for this server yet.");
  });

  it("says when the operator paused the app for everybody, and how many sessions run", async () => {
    state.apps = [app("poll", { paused: true }), app("jogos", { liveSessions: 1 })];
    await mount(<AppsSettingsSection serverId="s1" />);
    expect(host.textContent).toContain("pqp paused this app for everyone for now.");
    expect(host.textContent).toContain("1 running now");
  });
});

describe("switching off", () => {
  it("an app with nobody inside goes off at once, with no question, and the request is false", async () => {
    write.mockResolvedValue({ appId: "poll", enabled: false, changed: true, sessionsEnded: 0 });
    await mount(<AppsSettingsSection serverId="s1" />);
    await click(switches()[0]!);
    expect(write).toHaveBeenCalledWith("s1", "poll", false);
    expect(switches()[0]!.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Switched off by you. Nobody can start it here.");
    expect(host.textContent).toContain("Saved.");
  });

  it("an app with sessions running asks first and says how many; Cancelar writes nothing", async () => {
    await mount(<AppsSettingsSection serverId="s1" />);
    await click(switches()[1]!);
    expect(write).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
    expect(dialog?.textContent).toContain("Switch off App jogos here?");
    expect(dialog?.textContent).toContain("2 sessions are running and will end now, with a notice to everyone inside.");
    const cancel = Array.from(dialog!.querySelectorAll("button")).find((b) => /cancel/i.test(b.textContent ?? ""));
    await click(cancel!);
    expect(write).not.toHaveBeenCalled();
    expect(switches()[1]!.getAttribute("aria-checked")).toBe("true");
  });

  it("confirming writes false and the app reads as off with no sessions", async () => {
    write.mockResolvedValue({ appId: "jogos", enabled: false, changed: true, sessionsEnded: 2 });
    await mount(<AppsSettingsSection serverId="s1" />);
    await click(switches()[1]!);
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Switch off");
    await click(confirm!);
    expect(write).toHaveBeenCalledWith("s1", "jogos", false);
    expect(switches()[1]!.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).not.toContain("running now");
  });

  it("a refused write puts the switch back and says so", async () => {
    write.mockRejectedValue(new Error("nope"));
    await mount(<AppsSettingsSection serverId="s1" />);
    await click(switches()[0]!);
    expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not save. The switch went back to how it was.");
  });

  it("a write that failed after the server committed it shows what the server holds", async () => {
    // The session cleanup of an off can fail on its own, after the switch is stored.
    write.mockImplementation(() => {
      state.apps = [app("poll", { enabled: false }), app("jogos", { liveSessions: 2 })];
      return Promise.reject(new Error("500"));
    });
    await mount(<AppsSettingsSection serverId="s1" />);
    expect(fetchApps).toHaveBeenCalledTimes(1);
    await click(switches()[0]!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchApps).toHaveBeenCalledTimes(2);
    expect(switches()[0]!.getAttribute("aria-checked")).toBe("false");
  });

  it("a slow re-read after a failed write never draws over a later switch", async () => {
    write.mockRejectedValueOnce(new Error("500"));
    await mount(<AppsSettingsSection serverId="s1" />);
    // The re-read is held until after the next write has finished.
    let release: (value: { apps: ReturnType<typeof app>[] }) => void = () => {};
    const stale = { apps: [app("poll"), app("jogos", { liveSessions: 2 })] };
    state.hold = new Promise((resolve) => {
      release = resolve;
    });
    await click(switches()[0]!);
    write.mockResolvedValue({ appId: "poll", enabled: false, changed: true, sessionsEnded: 0 });
    await click(switches()[0]!);
    expect(switches()[0]!.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      release(stale);
      await Promise.resolve();
    });
    expect(switches()[0]!.getAttribute("aria-checked")).toBe("false");
  });
});

describe("switching back on", () => {
  it("sends null, which is the operator's release again, and never true", async () => {
    state.apps = [app("poll", { enabled: false })];
    write.mockResolvedValue({ appId: "poll", enabled: true, changed: true, sessionsEnded: 0 });
    await mount(<AppsSettingsSection serverId="s1" />);
    expect(switches()[0]!.getAttribute("aria-checked")).toBe("false");
    await click(switches()[0]!);
    expect(write).toHaveBeenCalledWith("s1", "poll", null);
    expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
  });
});

describe("loading", () => {
  it("a failed read says so and offers to try again, and trying again shows the list", async () => {
    state.fail = true;
    await mount(<AppsSettingsSection serverId="s1" />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load the apps. Try again.");
    expect(switches()).toHaveLength(0);
    state.fail = false;
    const retry = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Try again");
    await click(retry!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(switches()).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("the flag", () => {
  function Probe({ id, ready }: { id: string | null; ready: boolean }) {
    const on = useServerAppsEnabled(id, ready);
    return <p data-testid="on">{String(on)}</p>;
  }

  it("is asked of the config route and follows its answer", async () => {
    await mount(<Probe id="s1" ready />);
    expect(fetchConfig).toHaveBeenCalledWith("s1");
    expect(host.textContent).toBe("true");
  });

  it("with the flag off, or not yet ready, or no server, it is false and asks nothing it should not", async () => {
    state.config = { enabled: false };
    await mount(<Probe id="s1" ready />);
    expect(host.textContent).toBe("false");
    await mount(<Probe id={null} ready />);
    expect(host.textContent).toBe("false");
    fetchConfig.mockClear();
    await mount(<Probe id="s2" ready={false} />);
    expect(fetchConfig).not.toHaveBeenCalled();
    expect(host.textContent).toBe("false");
  });
});

describe("appLabel", () => {
  it("the reader's language, then English, then anything, then the fallback", () => {
    expect(appLabel({ "pt-BR": "Jogos", en: "Games" }, "pt-BR", "x")).toBe("Jogos");
    expect(appLabel({ en: "Games" }, "es", "x")).toBe("Games");
    expect(appLabel({ es: "Juegos" }, "pt-BR", "x")).toBe("Juegos");
    expect(appLabel({}, "pt-BR", "x")).toBe("x");
  });
});
