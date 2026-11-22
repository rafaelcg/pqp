// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_HINT_STORAGE_KEY } from "@/lib/apps/apps-hint";
import { AppsHint } from "./apps-hint";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
});

const card = () => document.querySelector('[data-corner-card="apps"]');

describe("the apps news card", () => {
  it("draws nothing and records nothing while it does not hold the corner", async () => {
    await mount(<AppsHint enabled={false} />);
    expect(card()).toBeNull();
    expect(localStorage.getItem(APPS_HINT_STORAGE_KEY)).toBeNull();
  });

  it("says what is new, in the person's language, and is spent when it draws", async () => {
    await mount(<AppsHint enabled />);
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("New: apps in the channel");
    expect(localStorage.getItem(APPS_HINT_STORAGE_KEY)).not.toBeNull();
  });

  it("is once per person: a second mount, a reload, draws nothing", async () => {
    await mount(<AppsHint enabled />);
    act(() => root?.unmount());
    host?.remove();
    await mount(<AppsHint enabled />);
    expect(card()).toBeNull();
  });

  it("Got it closes it and hands the corner on", async () => {
    const onDismiss = vi.fn();
    await mount(<AppsHint enabled onDismiss={onDismiss} />);
    const cta = [...document.querySelectorAll("button")].find(
      (one) => one.textContent === "Got it",
    )!;
    await act(async () => cta.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the X hands the corner on too", async () => {
    const onDismiss = vi.fn();
    await mount(<AppsHint enabled onDismiss={onDismiss} />);
    const x = card()!.querySelector<HTMLButtonElement>("button[aria-label]")!;
    await act(async () => x.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
