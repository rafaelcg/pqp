import type { AppConfigEntry, AppSessionSummary } from "@pqp/shared";
import type { AppJoinState } from "@/lib/apps/app-sessions-store";
import { isSeated } from "@/lib/apps/app-sessions-store";

/**
 * Which face of the join sheet (mock 04) a person is looking at, decided from
 * data and nothing else, so the sheet changes state when the world does and not
 * only when they press something:
 *
 *   ask       the first time: what the app sees, and Entrar (estado 1, 2)
 *   entering  both buttons locked, the room opening (estado 3)
 *   failed    the connection failed, Tentar de novo (estado 4)
 *   full      the room filled while they read, Assistir (estado 5)
 *   ended     the session ended before they entered (estado 6)
 *   disabled  the app is off on this server (estado 7)
 *   done      they are in: the sheet has nothing left to say
 */

export type JoinSheetFace = "ask" | "entering" | "failed" | "full" | "ended" | "disabled" | "done";

/** What the person did in the sheet itself, which data cannot know. */
export type JoinLocal =
  | { phase: "idle" }
  /** Accepting on the server, or waiting for the seat. */
  | { phase: "entering" }
  /** The consent could not be saved. */
  | { phase: "failed" };

export interface JoinSheetInput {
  session: AppSessionSummary | undefined;
  app: AppConfigEntry | undefined;
  viewerId: string | null;
  local: JoinLocal;
  /** The store's account of a join in flight or refused. */
  join: AppJoinState | undefined;
}

export function joinSheetFace(input: JoinSheetInput): JoinSheetFace {
  const { session, app, viewerId, local, join } = input;
  if (!session) {
    return "ended";
  }
  if (!app || !app.available) {
    return "disabled";
  }
  if (isSeated(session, viewerId)) {
    return "done";
  }
  if (join?.status === "failed") {
    return "failed";
  }
  if (local.phase === "failed") {
    return "failed";
  }
  if (local.phase === "entering" || join?.status === "joining") {
    // The room can fill while the request is out: the answer is a refusal
    // that is not a failure of the person, and the summary says the rest.
    return session.players >= app.players.max && join?.status !== "joining" ? "full" : "entering";
  }
  return session.players >= app.players.max ? "full" : "ask";
}

/** A failed join that is not a connection problem has its own sentence. */
export function failureOf(join: AppJoinState | undefined): "connection" | "not-allowed" | "rate-limited" | "unavailable" {
  return join?.status === "failed" ? join.code : "connection";
}

/**
 * Whether the join sheet adds "Guarda coisas neste aparelho" to what the app
 * sees: the manifest declares `capabilities.deviceStore`. The consent goes
 * stale on its own when a version adds it (the server compares capabilities),
 * so a person who accepted before is asked again, which is the point.
 */
export function keepsOnDevice(app: Pick<AppConfigEntry, "capabilities"> | undefined): boolean {
  return app?.capabilities.deviceStore?.allowed === true;
}

/**
 * Whether the join sheet says the saves also go to the account: the config
 * answered `saveSync` (Locadora, where `locadora_save_sync` is on for this
 * server). Then the device line stops saying the saves stay only here, which
 * would no longer be true, and a line says what goes and what never does.
 */
export function keepsOnAccount(app: Pick<AppConfigEntry, "saveSync"> | undefined): boolean {
  return app?.saveSync === true;
}

/** Whether Assistir is on offer (D14 included: `shareAllowed` is the emulator gate). */
export function canWatchFull(app: AppConfigEntry | undefined): boolean {
  return app !== undefined && app.players.spectators && app.shareAllowed;
}
