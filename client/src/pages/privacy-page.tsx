import { createLegalRoute } from "./legal/document";

/**
 * The Privacy Policy, in whichever language the visitor is reading the site in.
 * The prose lives in `legal/privacy.en.tsx` and `legal/privacy.pt-BR.tsx`; only
 * the one on screen is downloaded.
 */
export const PrivacyPage = createLegalRoute({
  en: () => import("./legal/privacy.en").then((m) => m.privacyEn),
  "pt-BR": () => import("./legal/privacy.pt-BR").then((m) => m.privacyPtBr),
});
