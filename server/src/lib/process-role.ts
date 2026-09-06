/**
 * Which half of the server this process is.
 *
 * One image, one env var, three answers:
 *
 *   * unset / `all`: today's behaviour, HTTP + WS listeners AND every batch
 *                      job in one process. Self-hosters and local dev.
 *   * `api`: listeners only. Every job in `jobs.ts` is skipped on
 *                      the assumption that a `worker` process runs them. Set
 *                      this on `pqp-api` only AFTER `pqp-worker` exists,
 *                      otherwise the sweeps simply stop.
 *   * `worker` (`1`): batch jobs only. No `/ws`, no `/api`, no static files;
 *                      the one listener is `/health` so the platform can
 *                      restart it. Set on `pqp-worker`.
 *
 * `1` is accepted as `worker` because "WORKER_MODE=1" is what a person types
 * when the variable reads like a boolean. An unknown value logs and behaves
 * as `all`: the failure mode of a typo must be "does extra work", never
 * "silently does none".
 */
export type ProcessRole = "all" | "api" | "worker";

export const WORKER_MODE_ENV = "WORKER_MODE";

export function parseProcessRole(raw: string | undefined): ProcessRole | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "all" || value === "0" || value === "false") {
    return "all";
  }
  if (value === "api") {
    return "api";
  }
  if (value === "worker" || value === "1" || value === "true") {
    return "worker";
  }
  return null;
}

export function processRole(
  env: NodeJS.ProcessEnv = process.env,
): ProcessRole {
  const raw = env[WORKER_MODE_ENV];
  const role = parseProcessRole(raw);
  if (role === null) {
    console.warn(
      `[role] unknown ${WORKER_MODE_ENV}=${raw}, running as "all". ` +
        `Supported: "api", "worker", "all" (or unset).`,
    );
    return "all";
  }
  return role;
}

/** True when this process is the one that runs the batch jobs in `jobs.ts`. */
export function runsColdJobs(role: ProcessRole): boolean {
  return role !== "api";
}

/** True when this process serves `/api`, `/ws` and the SPA. */
export function servesTraffic(role: ProcessRole): boolean {
  return role !== "worker";
}
