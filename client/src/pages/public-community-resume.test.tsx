// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function render(node: React.ReactElement) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(node));
  return () => act(() => root.unmount());
}

const clerk = {
  loaded: true,
  client: {
    signUp: { status: "missing_requirements", unverifiedFields: ["email_address"] } as
      | { status: string; unverifiedFields: string[] }
      | undefined,
  },
  openSignUp: vi.fn(() => Promise.resolve()),
};

vi.mock("@clerk/clerk-react", () => ({
  SignUpButton: ({ children }: { children: unknown }) => children,
  SignedIn: () => null,
  SignedOut: () => null,
  useClerk: () => clerk,
}));

import { ResumeSignUp } from "./public-community-page";
import { SIGNUP_ASSIST_OVERRIDE_KEY, noteSignupCta } from "@/lib/signup-assist";

describe("ResumeSignUp", () => {
  beforeEach(() => {
    localStorage.clear();
    clerk.openSignUp.mockClear();
    clerk.loaded = true;
    clerk.client.signUp = { status: "missing_requirements", unverifiedFields: ["email_address"] };
  });

  it("reopens the modal on the code step for a browser that tapped the button", () => {
    localStorage.setItem(SIGNUP_ASSIST_OVERRIDE_KEY, "on");
    noteSignupCta("community");
    render(<ResumeSignUp appHref="/app?join=moon" />);
    expect(clerk.openSignUp).toHaveBeenCalledWith({ forceRedirectUrl: "/app?join=moon" });
  });

  it("does nothing with the flag off", () => {
    noteSignupCta("community");
    render(<ResumeSignUp appHref="/app?join=moon" />);
    expect(clerk.openSignUp).not.toHaveBeenCalled();
  });

  it("does nothing for a visitor who never tapped, or with nothing pending", () => {
    localStorage.setItem(SIGNUP_ASSIST_OVERRIDE_KEY, "on");
    render(<ResumeSignUp appHref="/app?join=moon" />);
    expect(clerk.openSignUp).not.toHaveBeenCalled();
    noteSignupCta("community");
    clerk.client.signUp = undefined;
    render(<ResumeSignUp appHref="/app?join=moon" />);
    expect(clerk.openSignUp).not.toHaveBeenCalled();
  });
});
