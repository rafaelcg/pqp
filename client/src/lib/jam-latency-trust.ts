import type { LatencyConfidence, LatencyMethod } from "@/lib/jam";

/**
 * Whether the delay the studio corrects a take by was MEASURED, which is the
 * only time the screen may say "set" and "in time" and draw it in the colour of
 * good news.
 *
 * The browser's own guess (`method: "estimate"`, `confidence: "low"`) is a number
 * the studio uses because the red button must work before anybody has measured
 * anything. It is often right and sometimes 40 ms off, and the person recording
 * cannot tell which from a green check. So a guess is shown as a guess, in
 * neutral, with the way to replace it beside it; a loopback or tap-along
 * measurement that came back sure of itself, or a number the person typed on
 * purpose, is what earns the check.
 */
export function latencyIsMeasured(result: { method: LatencyMethod; confidence: LatencyConfidence }): boolean {
  if (result.method === "estimate") {
    return false;
  }
  return result.confidence === "high" || result.confidence === "medium" || result.method === "manual";
}
