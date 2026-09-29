import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Map a request pathname to a file INSIDE `root`, or null. The pathname is
 * decoded first (so `%2e%2e%2f` is seen for what it is), then the resolved
 * path must still be under the root. Null bytes are refused.
 */
export function resolveInside(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) {
    return null;
  }
  const base = resolve(root);
  const candidate = resolve(join(base, decoded));
  const rel = relative(base, candidate);
  if (rel === "" ) {
    return candidate;
  }
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    return null;
  }
  return candidate;
}
