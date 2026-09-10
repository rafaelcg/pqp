/**
 * `virtual:pwa-register` only exists once vite-plugin-pwa has run, and it does
 * not run under vitest. `register-sw.ts` imports it dynamically so a plain
 * `tsc` run is happy, but Vite's import analysis still has to resolve the
 * specifier, so the suite needs something at that name. `vitest.config.ts`
 * aliases it here.
 *
 * Nothing in the suite calls this: `UpdatePrompt` takes its registrar as a
 * prop precisely so a test can drive a build arriving.
 */
export function registerSW(): (reloadPage?: boolean) => Promise<void> {
  return async () => {};
}
