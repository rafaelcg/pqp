import { apiFetch } from "@/lib/api";

/**
 * `POST /api/app-sessions/:id/take-host`: the person the server chose as the
 * next host, during the countdown, takes the role at once instead of waiting
 * for it ("Assumir agora"). Only that person is let through; the server
 * answers anybody else with a refusal and the strip says it did not work.
 */
export async function takeHostRequest(sessionId: string): Promise<void> {
  await apiFetch<unknown>(`/api/app-sessions/${encodeURIComponent(sessionId)}/take-host`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
