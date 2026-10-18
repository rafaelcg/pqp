import { createContext, type ReactNode, useContext } from "react";
import { type ServerBotClaims, serverBotClaims } from "@/lib/server-bots-launch";

export { botFaqAnswer, SAMPLE_BOT, type ServerBotClaims } from "@/lib/server-bots-launch";

/**
 * How a home section asks whether it may make a server-bot claim. Null means
 * no: no bot tile, no bot FAQ, no bot line anywhere. The answer comes from the
 * launch switches in `lib/server-bots-launch.ts`, read at render, unless a
 * `BotClaimsPreview` above says otherwise.
 *
 * Nothing on "/" renders `BotClaimsPreview`, so the live page always follows
 * the switches. The FAQ JSON-LD for "/" follows the switches too, never this
 * override (`landingFaq` in `lib/marketing-meta.ts`).
 */

const Override = createContext<ServerBotClaims | null | undefined>(undefined);

/** Tests and a dev-only preview: renders the page as if the switches said `value`. */
export function BotClaimsPreview({ value, children }: { value: ServerBotClaims | null; children: ReactNode }) {
  return <Override.Provider value={value}>{children}</Override.Provider>;
}

export function useServerBotClaims(): ServerBotClaims | null {
  const override = useContext(Override);
  return override === undefined ? serverBotClaims() : override;
}
