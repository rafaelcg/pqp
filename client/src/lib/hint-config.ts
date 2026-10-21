import { useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";
import { hintDietFromConfig, setHintDiet } from "@/lib/hint-diet";
import { hintBudgetFromConfig, setHintBudget } from "@/lib/hint-quiet";

/**
 * The two hint switches, `hint_diet` and `hint_budget` (both global, default
 * off, `docs/FEATURE_FLAGS.md`), served as `hintDiet` and `hintBudget` on
 * `GET /api/onboarding/config` beside the first-run switches the same route
 * already carries. Asked once per page after the age gate and again on every
 * config refresh, so a flip on the dashboard reaches open tabs on their next
 * focus.
 *
 * Both are client presentation only. Off, nothing on screen differs from
 * before: a missing field (an older API), a 404 or a failed ask keeps the last
 * answer, and the first answer defaults to off.
 */
export const fetchHintConfig = () =>
  apiFetch<{ hintDiet?: boolean; hintBudget?: boolean }>("/api/onboarding/config");

/**
 * SETTLED: the first answer (or the first failure, or `SETTLE_MAX_MS`) is in.
 * Until then the queues hold every unsolicited hint, so a card the diet would
 * hide cannot paint, and stamp itself as seen, in the few hundred
 * milliseconds between the app mounting and the flag arriving. With both
 * flags off the cost is that one round trip, which the app's own first loads
 * already outlast; the cap is for an API that never answers.
 */
export const SETTLE_MAX_MS = 2000;
let settled = false;
const settledListeners = new Set<() => void>();

function setSettled(next: boolean): void {
  if (next === settled) {
    return;
  }
  settled = next;
  for (const listener of [...settledListeners]) {
    listener();
  }
}

export function isHintConfigSettled(): boolean {
  return settled;
}

export function useHintConfigSettled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    },
    isHintConfigSettled,
    () => false,
  );
}

/**
 * Asks can overlap (the first read and a focus refresh); only an answer newer
 * than the last one applied counts, so a slow stale `true` cannot undo a flip.
 */
let asked = 0;
let applied = 0;
/**
 * One per signed-in account's stay on the page (`startHintConfig` to its
 * teardown). A request that finishes after its lifecycle ended answers for an
 * account that is gone: it may neither apply its flags nor release the queues
 * of the lifecycle that replaced it.
 */
let lifecycle = 0;

export async function loadHintConfig(
  fetcher: () => Promise<{
    hintDiet?: unknown;
    hintBudget?: unknown;
  }> = fetchHintConfig,
): Promise<void> {
  asked += 1;
  const mine = asked;
  const mineLifecycle = lifecycle;
  try {
    const answer = await fetcher();
    if (mine > applied && mineLifecycle === lifecycle) {
      applied = mine;
      setHintDiet(hintDietFromConfig(answer));
      setHintBudget(hintBudgetFromConfig(answer));
    }
  } catch {
    // An older API (404) or a blip: keep the last answer.
  } finally {
    if (mineLifecycle === lifecycle) {
      setSettled(true);
    }
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startHintConfig(): () => void {
  lifecycle += 1;
  const mine = lifecycle;
  void loadHintConfig();
  const settleTimer = setTimeout(() => {
    if (mine === lifecycle) {
      setSettled(true);
    }
  }, SETTLE_MAX_MS);
  const stop = onConfigRefresh(() => {
    void loadHintConfig();
  });
  return () => {
    stop();
    clearTimeout(settleTimer);
    lifecycle += 1;
    setSettled(false);
    // The answer belongs to the account that asked.
    asked += 1;
    applied = asked;
    setHintDiet(false);
    setHintBudget(false);
  };
}

/** Test seam. */
export function resetHintConfigForTests(): void {
  asked = 0;
  applied = 0;
  lifecycle = 0;
  settled = false;
  settledListeners.clear();
}
