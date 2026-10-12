// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  devLivePreviewAuth,
  hasClerkReturnHash,
  type LivePreviewAuth,
} from "./live-preview-auth";
import { SignUpBlock } from "./live-preview-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(auth: LivePreviewAuth, handlers: {
  onFirstTouch: () => void;
  onSignUp: () => void;
  onSignIn: () => void;
}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SignUpBlock auth={auth} {...handlers} />));
  return host;
}

/**
 * The sign-up inside the end sheet and the chat card. With Clerk it is
 * Clerk's own form, which we never see the clicks of, so the stashes (the
 * join intent, the channel to land on, the attribution) must run on the
 * first touch of it, once, before a provider can take the page away.
 */
describe("SignUpBlock", () => {
  it("draws Clerk's inline form and stashes on the first touch only", () => {
    const onFirstTouch = vi.fn();
    const onSignUp = vi.fn();
    const onSignIn = vi.fn();
    const auth: LivePreviewAuth = {
      signUp: vi.fn(),
      signIn: vi.fn(),
      renderInlineSignUp: () => <button type="button" data-clerk-form="">Google</button>,
    };
    const page = mount(auth, { onFirstTouch, onSignUp, onSignIn });
    const clerkButton = page.querySelector<HTMLButtonElement>("[data-clerk-form]")!;
    expect(clerkButton).not.toBeNull();
    // No "Criar conta" button of ours beside Clerk's form.
    expect(page.querySelectorAll("button")).toHaveLength(2);

    act(() => {
      clerkButton.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      clerkButton.focus();
      clerkButton.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    });
    expect(onFirstTouch).toHaveBeenCalledTimes(1);
    expect(onSignUp).not.toHaveBeenCalled();

    const signIn = [...page.querySelectorAll("button")].find(
      (button) => !button.hasAttribute("data-clerk-form"),
    )!;
    act(() => signIn.click());
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("without Clerk (the dev bypass) is one sign-up button, and every path goes the dev way", () => {
    const go = vi.fn();
    const auth = devLivePreviewAuth(go);
    expect(auth.renderInlineSignUp).toBeNull();
    auth.signUp();
    auth.signIn();
    expect(go).toHaveBeenCalledTimes(2);

    const onSignUp = vi.fn();
    const page = mount(auth, { onFirstTouch: vi.fn(), onSignUp, onSignIn: vi.fn() });
    const buttons = page.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    act(() => buttons[0]!.click());
    expect(onSignUp).toHaveBeenCalledTimes(1);
  });
});

describe("an inline sign-up coming back to the page", () => {
  it("is recognised on Clerk's own return steps and nothing else", () => {
    expect(hasClerkReturnHash("#/sso-callback")).toBe(true);
    expect(hasClerkReturnHash("#/sso-callback?__clerk_status=x")).toBe(true);
    expect(hasClerkReturnHash("#/continue")).toBe(true);
    expect(hasClerkReturnHash("#/verify-email-address")).toBe(true);
    expect(hasClerkReturnHash("")).toBe(false);
    expect(hasClerkReturnHash("#about")).toBe(false);
    expect(hasClerkReturnHash("#/factor-one")).toBe(false);
  });
});
