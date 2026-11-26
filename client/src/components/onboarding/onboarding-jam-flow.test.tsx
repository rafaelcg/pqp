// @vitest-environment jsdom
import type { User } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { i18n, loadLocale, setActiveCatalogue } from "@/lib/i18n/instance";
import type { JamHandover } from "@/lib/jam-handover";
import type { OnboardingPath } from "@/lib/onboarding";
import { AgeGateDialog } from "@/components/user/age-gate-dialog";
import { JamArrivalCard } from "./jam-arrival-card";
import { OnboardingFlow } from "./onboarding-flow";

/**
 * The first run for somebody who came from the public jam site, as they meet
 * it: an account that already has a name is out of the wizard the moment the
 * age gate is (no room step, no name step), an account with no name gets the
 * one name step with "tua jam tá esperando" on it and no room behind it, and
 * every other path is the wizard it always was.
 */

const { updatePreferences } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updatePreferences,
  updateMe: vi.fn(),
  fetchMembers: vi.fn(async () => []),
}));
vi.mock("@/lib/track", () => ({
  track: vi.fn(),
  trackOnboardingStart: vi.fn(),
  markOnboarded: vi.fn(),
  secondsSinceOnboardingStart: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  updatePreferences.mockReset();
  updatePreferences.mockResolvedValue({});
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

function makeUser(displayName: string): User {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    clerkId: "user_test",
    displayName,
    username: "marina",
    discriminator: "0417",
    tag: "marina#0417",
    avatarUrl: null,
    customStatus: null,
    bannerUrl: null,
    handle: null,
    handleChangedAt: null,
    preferences: {},
    dmPrivacy: "server_members",
    ageGate: "passed",
    isInstanceModerator: false,
  };
}

const JAM: JamHandover = {
  target: "11111111-2222-4333-8444-555555555555",
  record: true,
  instrument: "bass",
  title: "Café com leite",
  at: Date.now(),
};

async function render(node: React.ReactNode, locale: "en" | "pt-BR" | "es" = "pt-BR") {
  window.localStorage.setItem("pqp:locale", locale);
  await loadLocale(locale);
  await i18n.changeLanguage(locale);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <I18nProvider>{node}</I18nProvider>
      </MemoryRouter>,
    );
  });
}

function flow(path: OnboardingPath, user: User, onDone = vi.fn(), jam: JamHandover | null = null) {
  return (
    <OnboardingFlow
      user={user}
      path={path}
      jam={jam}
      onImportDiscord={vi.fn()}
      onUserUpdated={vi.fn()}
      onServerCreated={vi.fn()}
      onServerJoined={vi.fn()}
      onDone={onDone}
    />
  );
}

const body = () => document.body.textContent ?? "";
const dots = () => document.querySelector("[data-onboarding-progress]");

describe("the jam path", () => {
  it("shows an account that already has a name no wizard at all, and records it as done", async () => {
    const onDone = vi.fn();
    await render(flow("jam", makeUser("Marina Souza"), onDone, JAM));
    expect(document.querySelector("[data-onboarding-step]")).toBeNull();
    expect(body()).not.toContain("Onde a galera vai ficar?");
    expect(onDone).toHaveBeenCalledTimes(1);
    // Closed for good on every device, like any other way out of the flow.
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).toHaveBeenCalledWith({
      onboardedAt: expect.any(String),
    });
  });

  it("asks an account with no name for one, with the jam on the screen, and never for a room", async () => {
    const onDone = vi.fn();
    await render(flow("jam", makeUser("User 1a2b"), onDone, JAM));
    expect(onDone).not.toHaveBeenCalled();
    expect(document.querySelector('[data-onboarding-step="you"]')).not.toBeNull();
    expect(document.querySelector("[data-jam-arrival]")).not.toBeNull();
    expect(body()).toContain("Tua jam tá esperando");
    expect(body()).toContain("Café com leite");
    // One screen counted: no dots to promise a second.
    expect(dots()).toBeNull();
    // The primary leaves for the song and the wizard ends there.
    const primary = document.querySelector<HTMLButtonElement>("[data-onboarding-primary]")!;
    expect(primary.textContent).toBe("Ir pra jam");
    await act(async () => primary.click());
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-onboarding-step="room"]')).toBeNull();
  });

  it("says it in each language", async () => {
    for (const [locale, waiting, go] of [
      ["en", "Your jam is waiting", "Go to the jam"],
      ["pt-BR", "Tua jam tá esperando", "Ir pra jam"],
      ["es", "Tu jam te está esperando", "Ir a la jam"],
    ] as const) {
      await render(flow("jam", makeUser("User 1a2b"), vi.fn(), JAM), locale);
      expect(body(), locale).toContain(waiting);
      expect(document.querySelector("[data-onboarding-primary]")?.textContent, locale).toBe(go);
      act(() => root!.unmount());
      root = createRoot(host!);
      setActiveCatalogue(undefined);
    }
  });
});

describe("every other path is the wizard it always was", () => {
  it("a cold sign-up with a real name still sees step one of four, no jam card, and goes on to the room", async () => {
    await render(flow("cold", makeUser("Marina Souza")));
    expect(document.querySelector('[data-onboarding-step="you"]')).not.toBeNull();
    expect(document.querySelector("[data-jam-arrival]")).toBeNull();
    expect(dots()?.getAttribute("data-onboarding-progress")).toBe("2");
    expect(dots()?.getAttribute("data-onboarding-total")).toBe("4");
    expect(document.querySelector("[data-onboarding-primary]")?.textContent).toBe("Continuar");
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-onboarding-primary]")!.click(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(document.querySelector('[data-onboarding-step="room"]')).not.toBeNull();
    expect(body()).toContain("Onde a galera vai ficar?");
  });

  it("the invite and import paths keep two dots and their own buttons", async () => {
    await render(flow("import", makeUser("Marina Souza")));
    expect(dots()?.getAttribute("data-onboarding-total")).toBe("2");
    expect(document.querySelector("[data-onboarding-primary]")?.textContent).toBe(
      "Trazer meu servidor",
    );
    expect(document.querySelector("[data-jam-arrival]")).toBeNull();
  });

  it("a stray jam record never reaches a path that is not the jam path", async () => {
    await render(flow("cold", makeUser("Marina Souza"), vi.fn(), JAM));
    expect(document.querySelector("[data-jam-arrival]")).toBeNull();
  });
});

describe("the age gate's jam context", () => {
  it("draws the card above the fields on the jam path only, with no change to the declaration", async () => {
    await render(
      <AgeGateDialog
        status="pending"
        stepsTotal={1}
        path="jam"
        context={<JamArrivalCard handover={JAM} />}
        onPassed={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    expect(document.querySelector("[data-jam-arrival]")).not.toBeNull();
    expect(body()).toContain("Café com leite");
    // The gate is the gate: same title, same warning, same button, no dots.
    expect(body()).toContain("Tua data de nascimento");
    expect(body()).toContain("uma data de menor de 18 encerra a conta na hora");
    expect(document.querySelector("[data-age-gate-submit]")).not.toBeNull();
    expect(dots()).toBeNull();
  });

  it("without a context the gate has no card", async () => {
    await render(
      <AgeGateDialog
        status="pending"
        stepsTotal={4}
        path="cold"
        onPassed={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    expect(document.querySelector("[data-jam-arrival]")).toBeNull();
    expect(dots()?.getAttribute("data-onboarding-total")).toBe("4");
  });
});
