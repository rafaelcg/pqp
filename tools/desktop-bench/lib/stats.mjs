// Median and spread over the runs of one scene.
const sorted = (xs) => [...xs].sort((a, b) => a - b);

/** Linear-interpolated quantile of a non-empty list. */
export function quantile(xs, q) {
  const s = sorted(xs);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const round = (n) => Math.round(n * 100) / 100;

/** {median, min, max, p25, p75, spreadPct, n, values}. spreadPct is (max - min) / median. */
export function summarize(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return null;
  const median = quantile(xs, 0.5);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return {
    n: xs.length,
    median: round(median),
    min: round(min),
    max: round(max),
    p25: round(quantile(xs, 0.25)),
    p75: round(quantile(xs, 0.75)),
    spreadPct: median ? round(((max - min) / median) * 100) : null,
    values: xs.map(round),
  };
}

/** Median of one key across runs, for every key seen in any run. */
export function medianByKey(maps) {
  const keys = new Set(maps.flatMap((m) => Object.keys(m ?? {})));
  const out = {};
  for (const k of keys) {
    const s = summarize(maps.map((m) => m?.[k] ?? 0));
    out[k] = s ? { median: s.median, min: s.min, max: s.max } : null;
  }
  return out;
}

/** Flatten the numeric leaves of an `extras` object to dotted keys. */
export function flattenNumbers(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number") out[key] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) flattenNumbers(v, key, out);
  }
  return out;
}

/** Everything a scene's result file needs from its runs. */
export function summarizeScene(runs) {
  const ok = runs.filter((r) => !r.error);
  const extras = ok.map((r) => flattenNumbers(r.extras));
  const extraKeys = new Set(extras.flatMap((e) => Object.keys(e)));
  return {
    runs: runs.length,
    okRuns: ok.length,
    failedRuns: runs.length - ok.length,
    memTotalMB: summarize(ok.map((r) => r.memory?.totalMB)),
    cpuTotalPct: summarize(ok.map((r) => r.cpu?.totalPct)),
    memByProcessKindMB: medianByKey(ok.map((r) => r.memory?.byKeyMB)),
    cpuByProcessKindPct: medianByKey(ok.map((r) => r.cpu?.byKeyPct)),
    extras: Object.fromEntries(
      [...extraKeys].map((k) => [k, summarize(extras.map((e) => e[k]))]),
    ),
  };
}
