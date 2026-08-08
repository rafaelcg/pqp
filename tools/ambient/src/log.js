/**
 * The audit trail, and the kill switch.
 *
 * Every line the model produced is logged — posted, dropped by a guardrail, or
 * dropped as a repeat — with the reason. This is not telemetry: if somebody
 * ever asks "what did this account say and why", the answer has to be a file,
 * not a reconstruction. JSONL so `jq` is the whole reader.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `AMBIENT_KILL_SWITCH=1` stops every write to pqp, instantly, without a
 * deploy. Read per call rather than once at boot, so flipping the env on a
 * running machine (systemd override + reload, or a `fly secrets set` restart)
 * takes effect at the next scene rather than the next release.
 */
export function killSwitchEngaged() {
  const value = process.env.AMBIENT_KILL_SWITCH;
  return value === "1" || value === "true";
}

export function createLogger(path, { echo = true } = {}) {
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
  }
  return function log(event, fields = {}) {
    const record = { at: new Date().toISOString(), event, ...fields };
    if (path) {
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    }
    if (echo) {
      // Human-readable on the console, machine-readable on disk. The console
      // form is what an operator watches during a bootstrap run.
      const detail = Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      console.log(`[${record.at}] ${event} ${detail}`);
    }
    return record;
  };
}
