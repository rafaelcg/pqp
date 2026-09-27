import { useCallback, useRef } from "react";

/**
 * Returns a function with a PERMANENTLY stable identity that always calls
 * the LATEST version of `fn` — the "useEvent" pattern React itself has
 * floated for exactly this problem, ahead of a first-party hook landing.
 *
 * Written for one recurring shape in this codebase: a large component
 * (`App.tsx`'s `MainAppContent`, mainly) passes dozens of one-line handlers
 * straight into a `memo()`'d child — `onDeleteChannel={(id) =>
 * void handleDeleteChannel(id)}` and the like — and every one of those
 * inline arrows (or even a directly-passed named function that was never
 * itself wrapped in `useCallback`) is a brand-new reference on every render
 * of the parent, which defeats the child's memo just as completely as if it
 * were never memoized at all. Reproduced and measured against a busy
 * watch-party channel: with `ChannelList` wrapped in `memo()` but its props
 * left as plain closures, EVERY one of ~35 handler props read as changed on
 * every render, so the memo bought nothing.
 *
 * `useStableCallback` fixes that without requiring every individual handler
 * to be re-audited for its own correct `useCallback` dependency list — the
 * returned function's identity never changes, so passing it down is always
 * safe for `memo()`, while a call through it always reaches whatever `fn`
 * most recently was, so behavior is unchanged. It is not a substitute for
 * `useCallback` in general — memoizing a genuinely expensive computation
 * still wants real dependencies — but for "stabilize this handler prop so a
 * memoized child does not re-render on every keystroke elsewhere in a giant
 * component", it is the mechanical, low-risk fix.
 */
export function useStableCallback<Args extends unknown[], Return>(
  fn: (...args: Args) => Return,
): (...args: Args) => Return {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  return useCallback((...args: Args) => fnRef.current(...args), []);
}
