// @vitest-environment jsdom
import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readBundle } from "../bundle";
import { STRINGS } from "../i18n";
import { addToLibrary, sramKey, stateKey, thumbKey } from "../library";
import { memoryStore } from "../store";
import { createExportDialog } from "./export-dialog";
import { createTopBar } from "./top-bar";

/**
 * "Exportar pra arquivo": a FILE the person carries, not a sync. These pin what makes that obvious: the name, the
 * one-line lead, the two choices with what each is, the account-aware note, the privacy line, and the way back in
 * ("Importar de um arquivo") named the same way.
 */

const t = STRINGS["pt-BR"];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeNes(): Uint8Array {
  const out = new Uint8Array(16 + 2048);
  out.set([0x4e, 0x45, 0x53, 0x1a]);
  for (let i = 16; i < out.length; i += 1) out[i] = (i * 31) & 0xff;
  return out;
}

async function shelf() {
  const store = memoryStore();
  const rom = fakeNes();
  const added = await addToLibrary(store, { bytes: rom, ext: ".nes", fallbackTitle: "Jogo de teste", now: 1_000 });
  if (!added) throw new Error("refused");
  const sha = added.item.sha256;
  await store.put(sramKey(sha), new Uint8Array(300).fill(7), { savedAt: 2_000, size: 300 });
  await store.put(stateKey(sha, "1"), new Uint8Array(700).fill(3), { core: "fceumm", coreVersion: "4.2.3", savedAt: 3_000, origin: "device", enc: "raw", size: 700 });
  await store.put(thumbKey(sha, "1"), new Uint8Array(100).fill(1), { savedAt: 3_000 });
  return { store, rom };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

async function open(extra: Partial<Parameters<typeof createExportDialog>[0]> = {}) {
  const { store } = await shelf();
  const saveLocal = vi.fn(async () => undefined);
  const dialog = createExportDialog({ t, store, saveLocal, ...extra });
  dialog.openExport();
  await flush();
  return { dialog, saveLocal, store };
}

const radios = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const save = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t["export.save"])!;

describe("the words", () => {
  it("names it for what it is, in the three languages, and never says 'another device' as the title", () => {
    expect(STRINGS["pt-BR"]["export.title"]).toBe("Exportar pra arquivo");
    expect(STRINGS.en["export.title"]).toBe("Export to a file");
    expect(STRINGS.es["export.title"]).toBe("Exportar a un archivo");
    expect(STRINGS["pt-BR"]["import.title"]).toBe("Importar de um arquivo");
    expect(STRINGS["pt-BR"]["export.importButton"]).toBe("Importar de um arquivo");
    expect(STRINGS["pt-BR"]["export.lead"]).toBe("Salva a fita e os saves num arquivo pra tu levar pro outro aparelho. Nada sobe pra internet.");
    expect(STRINGS["pt-BR"]["export.cloud"]).toBe("Teus saves já vão pra tua conta; só a fita precisa ir no arquivo.");
    for (const locale of Object.keys(STRINGS) as Array<keyof typeof STRINGS>) {
      const s = STRINGS[locale];
      for (const key of ["export.title", "import.title", "export.save", "export.importButton"] as const) {
        expect(s[key], `${locale} ${key}`).not.toMatch(/outro aparelho|another device|otro dispositivo/i);
      }
      // the two choices say what is in them, and the size slot is there to be filled
      expect(s["export.choice.savesHint"]).toContain("{size}");
      expect(s["export.choice.allHint"]).toContain("{size}");
      expect(s["export.size"]).toContain("{size}");
    }
  });

  it("the top bar's icon is the same words, in its tooltip and its name", () => {
    const bar = createTopBar({ t, onPick: () => undefined, onExport: () => undefined });
    const button = bar.element.querySelector<HTMLButtonElement>('[aria-label="Exportar pra arquivo"]')!;
    expect(button).not.toBeNull();
    expect(button.dataset.tip).toBe("Exportar pra arquivo");
    expect(bar.element.textContent).not.toContain("Levar pra outro aparelho");
  });
});

describe("Exportar pra arquivo", () => {
  it("opens with the lead, two choices, the privacy line and no upload anywhere", async () => {
    const { dialog } = await open();
    const el = dialog.element;
    expect(el.querySelector("h2")!.textContent).toBe("Exportar pra arquivo");
    expect(el.querySelector(".loc-export__lead")!.textContent).toBe(t["export.lead"]);
    const group = el.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe(t["export.choose"]);
    expect(radios(el).map((r) => r.value)).toEqual(["saves", "all"]);
    const names = [...group.querySelectorAll("strong")].map((s) => s.textContent);
    expect(names).toEqual(["Só os saves", "Fita e saves"]);
    expect(el.textContent).toContain(t["export.privacy"]);
    expect(el.textContent).toContain("nunca é enviada");
    // every radio is named and described, so a screen reader gets the one-sentence difference
    for (const radio of radios(el)) {
      expect(radio.closest("label")).not.toBeNull();
      const described = radio.getAttribute("aria-describedby")!;
      expect(el.querySelector(`#${described}`)!.textContent!.length).toBeGreaterThan(20);
    }
  });

  it("without the account: saves only is chosen, and the note says the file is the only way for the saves", async () => {
    const { dialog } = await open({ savesOnAccount: () => false });
    const [saves, all] = radios(dialog.element);
    expect(saves!.checked).toBe(true);
    expect(all!.checked).toBe(false);
    const note = dialog.element.querySelector<HTMLElement>(".loc-export__cloud")!;
    expect(note.dataset.cloud).toBe("off");
    expect(note.textContent).toBe(t["export.noCloud"]);
    expect(dialog.element.textContent).not.toContain(t["export.cloud"]);
  });

  it("with the account: the note says only the cartridge needs the file, and the cartridge is chosen", async () => {
    const { dialog } = await open({ savesOnAccount: () => true });
    const [saves, all] = radios(dialog.element);
    expect(all!.checked).toBe(true);
    expect(saves!.checked).toBe(false);
    const note = dialog.element.querySelector<HTMLElement>(".loc-export__cloud")!;
    expect(note.dataset.cloud).toBe("on");
    expect(note.textContent).toBe("Teus saves já vão pra tua conta; só a fita precisa ir no arquivo.");
  });

  it("each choice says how big it is, from the listing: the cartridge's choice is the bigger one", async () => {
    const { dialog } = await open();
    const [savesHint, allHint] = [...dialog.element.querySelectorAll(".loc-export__hint")].map((n) => n.textContent!);
    // 300 + 700 + 100 bytes of saves and pictures, then the game on top
    expect(savesHint).toContain("Uns 1 KB.");
    expect(allHint).toContain("Uns 3 KB.");
    expect(savesHint).not.toContain("{");
  });

  it("an empty shelf's hint says there is no save yet, not '0 B'", async () => {
    const dialog = createExportDialog({ t, store: memoryStore(), saveLocal: vi.fn(async () => undefined) });
    dialog.openExport();
    await flush();
    expect(dialog.element.querySelector(".loc-export__hint")!.textContent).toContain("Ainda não tem save.");
  });

  it("'Só os saves' writes a file with no game in it; 'Fita e saves' writes one with the game", async () => {
    const { dialog, saveLocal } = await open();
    const rom = fakeNes();
    await (async () => {
      save(dialog.element).click();
      await flush();
      await flush();
    })();
    expect(saveLocal).toHaveBeenCalledTimes(1);
    const [bytes, ext] = saveLocal.mock.calls[0] as unknown as [Uint8Array, string];
    expect(ext).toBe(".locadora");
    const small = readBundle(bytes);
    expect(small.ok && small.bundle.items[0]!.rom).toBeNull();
    expect(dialog.element.textContent).toContain(t["export.done"]);

    radios(dialog.element)[1]!.checked = true;
    save(dialog.element).click();
    await flush();
    await flush();
    expect(saveLocal).toHaveBeenCalledTimes(2);
    const big = readBundle((saveLocal.mock.calls[1] as unknown as [Uint8Array])[0]);
    expect(big.ok && [...big.bundle.items[0]!.rom!]).toEqual([...rom]);
  });

  it("has no checkbox to find and tick any more", async () => {
    const { dialog } = await open();
    expect(dialog.element.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe("Importar de um arquivo", () => {
  it("is offered on the same sheet, with its own lead, and only where the host can pick a file", async () => {
    const without = await open();
    expect(without.dialog.element.querySelector(".loc-export__import")).toBeNull();
    document.body.innerHTML = "";
    const { dialog } = await open({ pickBundle: async () => ({ kind: "cancelled" }) });
    const button = dialog.element.querySelector<HTMLButtonElement>(".loc-export__import")!;
    expect(button.textContent).toBe("Importar de um arquivo");
    expect(dialog.element.querySelector(".loc-export__import-row")!.textContent).toContain(t["export.importLead"]);
  });

  it("a picked bundle goes to the import view (titled the same way); a game file is told it is not one; cancel changes nothing", async () => {
    const files = zipSync({ "manifest.json": strToU8(JSON.stringify({ format: "locadora-bundle", version: 1, createdAt: 1, items: [] })) });
    const picks: Array<Awaited<ReturnType<NonNullable<Parameters<typeof createExportDialog>[0]["pickBundle"]>>>> = [
      { kind: "cancelled" },
      { kind: "other" },
      { kind: "bundle", bytes: files },
    ];
    const { dialog } = await open({ pickBundle: async () => picks.shift()! });
    const button = () => dialog.element.querySelector<HTMLButtonElement>(".loc-export__import")!;
    button().click();
    await flush();
    expect(dialog.element.querySelector("h2")!.textContent).toBe("Exportar pra arquivo");
    button().click();
    await flush();
    expect(dialog.element.textContent).toContain(t["export.importNotFile"]);
    button().click();
    await flush();
    await flush();
    expect(dialog.element.querySelector("h2")!.textContent).toBe("Importar de um arquivo");
  });
});
