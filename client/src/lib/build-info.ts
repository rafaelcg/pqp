/**
 * Which build this page is running. Stamped by `client/vite.config.ts`
 * (`define`) and mirrored in `/version.json`, which is what a running page
 * compares itself to (`lib/version-watch.ts`).
 *
 * `vitest` does not load the Vite config, so the two constants do not exist
 * there; every read goes through `typeof` and lands on "dev" / 0. "dev" is also
 * what a `vite dev` session and a build with no commit to name report, and it
 * means "do not compare me": a developer's own tab must never be told it is out
 * of date, or reload itself, because a deploy landed somewhere else.
 */

export const DEV_BUILD_ID = "dev";

export const BUILD_ID: string =
  typeof __PQP_BUILD_ID__ === "string" && __PQP_BUILD_ID__.length > 0
    ? __PQP_BUILD_ID__
    : DEV_BUILD_ID;

export const BUILD_TIME: number =
  typeof __PQP_BUILD_TIME__ === "number" ? __PQP_BUILD_TIME__ : 0;

export interface BuildIdentity {
  build: string;
  builtAt: number;
}

export const RUNNING_BUILD: BuildIdentity = {
  build: BUILD_ID,
  builtAt: BUILD_TIME,
};
