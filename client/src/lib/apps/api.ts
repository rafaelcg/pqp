import {
  appSessionSummarySchema,
  appsConfigSchema,
  type AppSessionSummary,
  type AppsConfig,
} from "@pqp/shared";
import { apiFetch } from "@/lib/api";

/**
 * The REST half of apps (`server/src/api/app-routes.ts`, docs/APPS.md). Every
 * answer is parsed with the shared schema, which strips what an older client
 * does not know, so a field a newer server adds never reaches a component.
 */

/** `GET /api/apps/config?serverId=`: the launcher's list and the runtime's inputs. */
export async function fetchAppsConfig(serverId: string): Promise<AppsConfig> {
  const raw = await apiFetch<unknown>(
    `/api/apps/config?serverId=${encodeURIComponent(serverId)}`,
  );
  return appsConfigSchema.parse(raw);
}

/**
 * `GET /api/servers/:id/app-sessions`: every live app on a server, for the
 * channels the caller can view. Asked on server open and on socket reconnect.
 */
export async function fetchServerAppSessions(
  serverId: string,
): Promise<Array<{ channelId: string; session: AppSessionSummary }>> {
  const raw = await apiFetch<unknown>(
    `/api/servers/${encodeURIComponent(serverId)}/app-sessions`,
  );
  const rows = (raw as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(rows)) {
    return [];
  }
  // One row the schema cannot read is skipped, never the whole answer.
  const out: Array<{ channelId: string; session: AppSessionSummary }> = [];
  for (const row of rows as Array<{ channelId?: unknown; session?: unknown }>) {
    const parsed = appSessionSummarySchema.safeParse(row?.session);
    if (parsed.success && typeof row.channelId === "string") {
      out.push({ channelId: row.channelId, session: parsed.data });
    }
  }
  return out;
}

/** Why a start was refused, when the server said. */
export class AppStartError extends Error {
  constructor(
    readonly status: number,
    /** `cannot_start`, `app_unavailable`, `session_live`, `rate_limited`, or null. */
    readonly code: string | null,
    /** With `session_live`: the session that is in the way. */
    readonly session: AppSessionSummary | null,
    /** With `app_unavailable`: the first gate that failed. */
    readonly reason: string | null,
  ) {
    super(code ?? `start failed (${status})`);
    this.name = "AppStartError";
  }
}

/** `POST /api/channels/:id/app-sessions`: start `appId` here. */
export async function startAppSessionRequest(
  channelId: string,
  appId: string,
): Promise<AppSessionSummary> {
  try {
    const raw = await apiFetch<unknown>(
      `/api/channels/${encodeURIComponent(channelId)}/app-sessions`,
      { method: "POST", body: JSON.stringify({ appId }) },
    );
    return appSessionSummarySchema.parse(raw);
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status !== "number") {
      throw error;
    }
    const details = (error as { details?: unknown } | null)?.details as
      | { session?: unknown; reason?: unknown; error?: unknown }
      | null
      | undefined;
    const parsed = appSessionSummarySchema.safeParse(details?.session);
    throw new AppStartError(
      status,
      typeof details?.error === "string" ? details.error : null,
      parsed.success ? parsed.data : null,
      typeof details?.reason === "string" ? details.reason : null,
    );
  }
}

/** `POST /api/app-sessions/:id/end`. `false` means it was already over. */
export async function endAppSessionRequest(sessionId: string): Promise<boolean> {
  const raw = await apiFetch<{ ended?: boolean }>(
    `/api/app-sessions/${encodeURIComponent(sessionId)}/end`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return raw.ended === true;
}
