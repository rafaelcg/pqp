import { createLegalRoute } from "./legal/document";

/**
 * The Cookie notice, in whichever language the visitor is reading the site in.
 * The prose lives in `legal/cookies.en.tsx` and `legal/cookies.pt-BR.tsx`; only
 * the one on screen is downloaded.
 */
export const CookiesPage = createLegalRoute({
  en: () => import("./legal/cookies.en").then((m) => m.cookiesEn),
  "pt-BR": () => import("./legal/cookies.pt-BR").then((m) => m.cookiesPtBr),
});
