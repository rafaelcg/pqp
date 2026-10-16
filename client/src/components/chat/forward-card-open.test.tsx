// @vitest-environment jsdom
import type { MessageForward } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { NotInServerToast } from "@/components/forward/not-in-server-toast";
import { setForwardMemberServers } from "@/lib/forward";
import { I18nProvider } from "@/lib/i18n";
import { ForwardCard } from "./forward-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER = "11111111-1111-4111-8111-111111111111";
const POST = "22222222-2222-4222-8222-222222222222";

const card: MessageForward = {
  v: 1,
  kind: "bau_post",
  sourceServerId: SERVER,
  sourceServerName: "QG",
  sourceId: POST,
  title: "Sessão 11",
  excerpt: "o clip",
  url: `https://pqp.gg/app/server/${SERVER}/bau/${POST}`,
  createdAt: "2026-10-15T12:00:00.000Z",
};

function Where() {
  return <output data-where>{useLocation().pathname}</output>;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setForwardMemberServers(null);
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/app"]}>
          <ForwardCard forward={card} />
          <NotInServerToast />
          <Where />
        </MemoryRouter>
      </I18nProvider>,
    ),
  );
}

const tap = () =>
  act(() => {
    document
      .querySelector<HTMLElement>("[data-forward-card]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
const where = () => document.querySelector("[data-where]")!.textContent;

describe("tapping a forward card", () => {
  it("from a server you are not in says so and goes nowhere", () => {
    setForwardMemberServers(["33333333-3333-4333-8333-333333333333"]);
    mount();
    expect(document.querySelector("[data-not-in-server-toast]")).toBeNull();
    tap();
    expect(document.querySelector("[data-not-in-server-toast]")).not.toBeNull();
    expect(document.querySelector("[data-not-in-server-toast]")!.textContent).toContain(
      "You are not in that server",
    );
    expect(where()).toBe("/app");
  });

  it("from a server you are in opens the post", () => {
    setForwardMemberServers([SERVER]);
    mount();
    tap();
    expect(document.querySelector("[data-not-in-server-toast]")).toBeNull();
    expect(where()).toBe(`/app/server/${SERVER}/bau/${POST}`);
  });

  it("while the account's servers are not known yet, it still opens", () => {
    setForwardMemberServers(null);
    mount();
    tap();
    expect(where()).toBe(`/app/server/${SERVER}/bau/${POST}`);
  });
});
