import { isDesktopApp } from "@/lib/desktop";

/**
 * Where Clerk must land after Sair in this shell.
 *
 * On the web, `/` is the homepage and reads as having left. In Electron the
 * same path is still the app origin, but Clerk's default after-sign-out hop
 * can leave the window and open Chrome. Stay on `/app` so the signed-out
 * prompt is the next screen, not a new browser tab.
 */
export function desktopSignedOutPath(): "/app" | "/" {
  return isDesktopApp() ? "/app" : "/";
}

export function shouldRedeemDesktopTicket(
  lastTicket: string | null,
  ticket: string,
): boolean {
  return lastTicket !== ticket;
}

export function ticketSignInSucceeded(result: {
  createdSessionId?: string | null;
}): result is { createdSessionId: string } {
  return (
    typeof result.createdSessionId === "string" &&
    result.createdSessionId.length > 0
  );
}

export const SECOND_FACTOR_STRATEGIES = [
  "totp",
  "backup_code",
  "phone_code",
  "email_code",
] as const;

export type SecondFactorStrategy = (typeof SECOND_FACTOR_STRATEGIES)[number];

const STRATEGY_ORDER: SecondFactorStrategy[] = [
  "totp",
  "backup_code",
  "phone_code",
  "email_code",
];

function isSecondFactorStrategy(value: string): value is SecondFactorStrategy {
  return (SECOND_FACTOR_STRATEGIES as readonly string[]).includes(value);
}

export type TicketSignInOutcome =
  | { kind: "complete"; sessionId: string }
  | { kind: "second_factor"; strategies: SecondFactorStrategy[] }
  | { kind: "client_trust" }
  | { kind: "failed" };

export type TicketSignInSnapshot = {
  status?: string | null;
  createdSessionId?: string | null;
  supportedSecondFactors?: Array<{ strategy?: string | null }> | null;
};

export type DesktopTicketSignIn = {
  create: (params: {
    strategy: "ticket";
    ticket: string;
  }) => Promise<TicketSignInSnapshot>;
  prepareSecondFactor?: (params: {
    strategy: SecondFactorStrategy;
  }) => Promise<unknown>;
  attemptSecondFactor: (params: {
    strategy: SecondFactorStrategy;
    code: string;
  }) => Promise<TicketSignInSnapshot>;
};

/**
 * A Clerk ticket can land complete, or it can land on MFA.
 *
 * `signIn.create({ strategy: "ticket" })` spends the token. Treating
 * `needs_second_factor` as failure burned the ticket and left new shells
 * with no in-app Clerk modal to finish TOTP / SMS / backup codes.
 */
export function classifyTicketSignIn(
  result: TicketSignInSnapshot,
): TicketSignInOutcome {
  if (result.status === "needs_second_factor") {
    const strategies = (result.supportedSecondFactors ?? [])
      .map((factor) => factor.strategy)
      .filter((strategy): strategy is string => typeof strategy === "string")
      .filter(isSecondFactorStrategy);
    return {
      kind: "second_factor",
      strategies:
        strategies.length > 0 ? strategies : ["totp", "backup_code"],
    };
  }
  if (result.status === "needs_client_trust") {
    return { kind: "client_trust" };
  }
  if (ticketSignInSucceeded(result)) {
    return { kind: "complete", sessionId: result.createdSessionId };
  }
  return { kind: "failed" };
}

export function pickPreferredSecondFactor(
  strategies: SecondFactorStrategy[],
): SecondFactorStrategy {
  return (
    STRATEGY_ORDER.find((strategy) => strategies.includes(strategy)) ?? "totp"
  );
}

export function secondFactorNeedsPrepare(
  strategy: SecondFactorStrategy,
): strategy is "phone_code" | "email_code" {
  return strategy === "phone_code" || strategy === "email_code";
}

export async function redeemDesktopTicket(
  signIn: Pick<DesktopTicketSignIn, "create">,
  ticket: string,
): Promise<TicketSignInOutcome> {
  const result = await signIn.create({ strategy: "ticket", ticket });
  return classifyTicketSignIn(result);
}

export async function completeDesktopSecondFactor(
  signIn: Pick<DesktopTicketSignIn, "attemptSecondFactor">,
  params: { strategy: SecondFactorStrategy; code: string },
): Promise<TicketSignInOutcome> {
  const result = await signIn.attemptSecondFactor(params);
  return classifyTicketSignIn(result);
}

export function applyDesktopAuthStart(result: { ok: boolean; url: string }): {
  waiting: boolean;
  url: string;
  failed: boolean;
} {
  if (!result.ok && !result.url) {
    return { waiting: false, url: "", failed: true };
  }
  return { waiting: true, url: result.url, failed: false };
}

export function desktopAuthEndedHandoff(reason: "expired" | "cancelled"): {
  waiting: false;
  expired: boolean;
} {
  return { waiting: false, expired: reason === "expired" };
}
