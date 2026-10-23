// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { I18nProvider } from "@/lib/i18n";
import { i18n, loadLocale, setActiveCatalogue } from "@/lib/i18n/instance";
import { AgeGateDialog } from "./age-gate-dialog";

/**
 * The age gate's read-back step, as a person meets it: what it says in each
 * language, that Corrigir and Escape keep what was typed, that only the
 * confirm button sends, that the kill switch restores the direct submit, and
 * that the server's "check the year" lands back on the fields with the attempt
 * still theirs. The arithmetic is pinned in `packages/shared` and the server.
 */

const { submitAgeCheck } = vi.hoisted(() => ({ submitAgeCheck: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  submitAgeCheck,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const onPassed = vi.fn();
const onStale = vi.fn();

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  submitAgeCheck.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.localStorage.removeItem("pqp:locale");
  setActiveCatalogue(undefined);
  vi.clearAllMocks();
});

async function open(
  props: { readback?: boolean; status?: "pending" | "blocked" } = {},
  locale: "en" | "pt-BR" | "es" = "en",
) {
  window.localStorage.setItem("pqp:locale", locale);
  // Settled before the render, not raced against `setActiveCatalogue`'s own
  // un-awaited switch back to English from the previous test.
  await loadLocale(locale);
  await i18n.changeLanguage(locale);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <I18nProvider>
          <AgeGateDialog
            status={props.status ?? "pending"}
            readback={props.readback ?? true}
            onPassed={onPassed}
            onStale={onStale}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
  });
}

function setField(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const day = () => document.querySelector<HTMLInputElement>('input[autocomplete="bday-day"]')!;
const month = () => document.querySelector<HTMLSelectElement>("select")!;
const year = () => document.querySelector<HTMLInputElement>('input[autocomplete="bday-year"]')!;
const cont = () => document.querySelector<HTMLButtonElement>("[data-age-gate-submit]")!;
const confirm = () => document.querySelector<HTMLButtonElement>("[data-age-gate-confirm]");
const edit = () => document.querySelector<HTMLButtonElement>("[data-age-gate-edit]");
const readbackGroup = () => document.querySelector<HTMLElement>("[data-age-gate-readback]");

function type(d: string, m: string, y: string) {
  setField(day(), d);
  setField(month(), m);
  setField(year(), y);
}

async function press(target: Element | Document, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("the read-back step", () => {
  it("says the date back in words, in each language, and sends nothing yet", async () => {
    for (const [locale, born, check] of [
      ["en", "You were born on December 3, 2008.", "Check the day, the month and the year."],
      ["pt-BR", "Tu nasceu em 3 de dezembro de 2008.", "Confere o dia, o mês e o ano."],
      ["es", "Naciste el 3 de diciembre de 2008.", "Revisa el día, el mes y el año."],
    ] as const) {
      await open({}, locale);
      type("3", "12", "2008");
      await act(async () => cont().click());
      expect(document.body.textContent, locale).toContain(born);
      expect(document.body.textContent, locale).toContain(check);
      expect(submitAgeCheck).not.toHaveBeenCalled();
      act(() => root!.unmount());
      root = createRoot(host!);
      setActiveCatalogue(undefined);
    }
  });

  it("names the buttons in the person's language", async () => {
    await open({}, "pt-BR");
    type("3", "12", "2008");
    await act(async () => cont().click());
    expect(confirm()?.textContent).toBe("Está certo");
    expect(edit()?.textContent).toBe("Corrigir");
  });

  it("moves focus to the read-back itself and labels it with the sentence", async () => {
    await open();
    type("3", "12", "2008");
    await act(async () => cont().click());
    const group = readbackGroup()!;
    expect(document.activeElement).toBe(group);
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe(
      "You were born on December 3, 2008. Check the day, the month and the year.",
    );
  });

  it("Corrigir returns to the fields with what was typed still in them", async () => {
    await open();
    type("3", "12", "2008");
    await act(async () => cont().click());
    await act(async () => edit()!.click());
    expect(readbackGroup()).toBeNull();
    expect(day().value).toBe("3");
    expect(month().value).toBe("12");
    expect(year().value).toBe("2008");
    expect(document.activeElement).toBe(day());
    expect(submitAgeCheck).not.toHaveBeenCalled();
  });

  it("Escape goes back and never closes the gate", async () => {
    await open();
    type("3", "12", "2008");
    await act(async () => cont().click());
    await press(document.activeElement!, "Escape");
    expect(readbackGroup()).toBeNull();
    expect(year().value).toBe("2008");
    // Still the gate, still blocking: another Escape on the fields does nothing.
    await press(document.activeElement!, "Escape");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector("[data-age-gate-submit]")).not.toBeNull();
    expect(submitAgeCheck).not.toHaveBeenCalled();
  });

  it("only the confirm button sends the date; Enter elsewhere does not", async () => {
    submitAgeCheck.mockResolvedValue({ ageGate: "passed" });
    await open();
    type("3", "12", "2008");
    await act(async () => cont().click());
    await press(readbackGroup()!, "Enter");
    expect(submitAgeCheck).not.toHaveBeenCalled();
    expect(document.querySelector("form")).toBeNull();

    await act(async () => confirm()!.click());
    expect(submitAgeCheck).toHaveBeenCalledTimes(1);
    expect(submitAgeCheck).toHaveBeenCalledWith("2008-12-03");
    expect(onPassed).toHaveBeenCalledTimes(1);
  });

  it("shows the same screen for a date that will block, and still sends only on confirm", async () => {
    submitAgeCheck.mockResolvedValue({ ageGate: "blocked" });
    await open();
    type("3", "12", "2012");
    await act(async () => cont().click());
    expect(readbackGroup()?.textContent).toContain("December 3, 2012");
    expect(submitAgeCheck).not.toHaveBeenCalled();
    await act(async () => confirm()!.click());
    expect(document.querySelector("[data-age-gate-contact]")).not.toBeNull();
  });

  it("does not read back a day the month does not have", async () => {
    await open();
    type("31", "2", "2008");
    await act(async () => cont().click());
    expect(readbackGroup()).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "not a date we can read",
    );
    expect(submitAgeCheck).not.toHaveBeenCalled();
  });
});

describe("with the switch off", () => {
  it("Continue sends the date straight away, as it always did", async () => {
    submitAgeCheck.mockResolvedValue({ ageGate: "passed" });
    await open({ readback: false });
    type("3", "12", "2008");
    await act(async () => cont().click());
    expect(readbackGroup()).toBeNull();
    expect(submitAgeCheck).toHaveBeenCalledWith("2008-12-03");
    expect(onPassed).toHaveBeenCalledTimes(1);
  });
});

describe("the server's plausibility floor", () => {
  const implausible = () =>
    new ApiError(400, "That date of birth does not look right. Check the year.", null, {
      error: "That date of birth does not look right. Check the year.",
      code: "birth_date_implausible",
    });

  it("asks to check the year, keeps the values and lets the person resubmit", async () => {
    submitAgeCheck.mockRejectedValueOnce(implausible());
    await open();
    type("3", "12", "2026");
    await act(async () => cont().click());
    await act(async () => confirm()!.click());

    // Back on the fields, not blocked, with the year under the cursor.
    expect(document.querySelector("[data-age-gate-contact]")).toBeNull();
    expect(readbackGroup()).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Check the year. That date of birth does not look right.",
    );
    expect(day().value).toBe("3");
    expect(month().value).toBe("12");
    expect(year().value).toBe("2026");
    expect(document.activeElement).toBe(year());

    // Correct it and go again: the second request is the real answer.
    submitAgeCheck.mockResolvedValueOnce({ ageGate: "passed" });
    setField(year(), "2002");
    await act(async () => cont().click());
    await act(async () => confirm()!.click());
    expect(submitAgeCheck).toHaveBeenLastCalledWith("2002-12-03");
    expect(onPassed).toHaveBeenCalledTimes(1);
  });

  it("says it in Portuguese with tu", async () => {
    submitAgeCheck.mockRejectedValueOnce(implausible());
    await open({}, "pt-BR");
    type("3", "12", "2026");
    await act(async () => cont().click());
    await act(async () => confirm()!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Confere o ano. Essa data de nascimento não parece certa.",
    );
  });

  it("works with the switch off too", async () => {
    submitAgeCheck.mockRejectedValueOnce(implausible());
    await open({ readback: false });
    type("3", "12", "2026");
    await act(async () => cont().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Check the year");
    expect(year().value).toBe("2026");
  });

  it("any other 400 keeps the generic message", async () => {
    submitAgeCheck.mockRejectedValueOnce(
      new ApiError(400, "Enter a valid date of birth.", null, { code: "birth_date_invalid" }),
    );
    await open({ readback: false });
    type("3", "12", "2008");
    await act(async () => cont().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "not a date we can read",
    );
  });
});

describe("the blocked screen", () => {
  it("carries the address and says to write from the account's email", async () => {
    await open({ status: "blocked" });
    const contact = document.querySelector("[data-age-gate-contact]")!;
    expect(contact.textContent).toContain("contato@pqp.gg");
    expect(contact.textContent).toContain("email address");
    expect(contact.querySelector("a")?.getAttribute("href")).toBe(
      "mailto:contato@pqp.gg",
    );
  });

  it("says it in Portuguese and Spanish", async () => {
    await open({ status: "blocked" }, "pt-BR");
    expect(document.querySelector("[data-age-gate-contact]")?.textContent).toBe(
      "Errou a data sem querer? Escreve pra contato@pqp.gg usando o e-mail da conta.",
    );
    act(() => root!.unmount());
    root = createRoot(host!);
    setActiveCatalogue(undefined);
    await open({ status: "blocked" }, "es");
    expect(document.querySelector("[data-age-gate-contact]")?.textContent).toBe(
      "¿Pusiste mal la fecha sin querer? Escribe a contato@pqp.gg desde el correo de la cuenta.",
    );
  });
});
