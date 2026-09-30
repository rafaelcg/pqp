import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidPage } from "./android-page";

// Same reasoning as apoie-page.test.tsx: the nav renders Clerk's sign-in
// CTAs, which need a ClerkProvider this test does not set up. The Android
// download story is unrelated to the auth buttons.
vi.mock("@/components/marketing/marketing-auth-ctas", () => ({
  MarketingAuthCtas: () => null,
}));

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AndroidPage />
    </MemoryRouter>,
  );
}

describe("AndroidPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leads with the Google Play badge by default (the listing is live)", () => {
    const html = render();
    expect(html).toContain('src="/images/google-play-badge-en.png"');
    expect(html).toContain("Get it on Google Play");
    // The APK stays reachable, as a small secondary link, pointed at the
    // GitHub release the direct-download surface always uses.
    expect(html).toContain("or download the APK directly");
    expect(html).toContain(
      'href="https://github.com/rafaelcg/pqp/releases/download/android-beta/pqp.apk"',
    );
    // The APK-only sideload steps do not belong on the Play-primary page.
    expect(html).not.toContain("How to install");
  });

  it("honours an override Play URL", () => {
    vi.stubEnv("VITE_PLAY_STORE_URL", "https://play.google.com/store/apps/details?id=gg.other");
    const html = render();
    expect(html).toContain('href="https://play.google.com/store/apps/details?id=gg.other&amp;hl=en"');
  });

  it("falls back to the pre-Play, APK-only page when the badge is hidden", () => {
    vi.stubEnv("VITE_PLAY_STORE_URL", " ");
    const html = render();
    expect(html).not.toContain("google-play-badge");
    expect(html).toContain("Download the APK");
    expect(html).toContain("How to install");
    expect(html).toContain("pqp on your Android, before the store");
  });

  it("hides the download story entirely when both links are hidden", () => {
    vi.stubEnv("VITE_PLAY_STORE_URL", " ");
    vi.stubEnv("VITE_ANDROID_APK_URL", " ");
    const html = render();
    expect(html).not.toContain("google-play-badge");
    expect(html).toContain("The APK is not up yet");
  });

  it("carries no dash punctuation in its English copy", () => {
    const html = render();
    for (const banned of ["—", "–", "―"]) {
      expect(html).not.toContain(banned);
    }
  });
});
