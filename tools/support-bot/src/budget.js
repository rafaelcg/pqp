/**
 * The hard ceiling on what this bot can spend, and the only piece of state it
 * keeps on disk.
 *
 * ── WHY A LEDGER AND NOT A COUNTER IN MEMORY ────────────────────────────────
 *
 * A counter in memory resets on restart, and restart is exactly what happens
 * when something goes wrong. The failure this guards against is not a slow
 * drift upward, it is a loop or a flood that burns a month of budget in an
 * afternoon while the process crashes and comes back a dozen times. A ledger on
 * disk survives all twelve restarts; a counter survives none of them.
 *
 * Two ceilings rather than one, because they fail differently. The call count
 * is the one an operator can reason about ("150 questions a day is more than
 * this community asks"). The dollar figure is the one that stays true if the
 * model, the prompt size or the pricing changes underneath it. Whichever binds
 * first wins.
 *
 * The date is the calendar day in the community's timezone, not UTC and not a
 * rolling 24 hours. A rolling window is harder to explain and a UTC day rolls
 * over at 21:00 in São Paulo, in the middle of the busiest hour.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** What a day looks like when nothing has happened in it yet. */
function emptyDay(date) {
  return { date, calls: 0, usd: 0 };
}

/**
 * The local calendar date, as `YYYY-MM-DD`, in `timeZone`.
 *
 * `sv-SE` because its locale format is ISO 8601 and this is the shortest way to
 * get a timezone-correct date string out of Intl without pulling in a date
 * library for one line.
 */
export function localDate(now = new Date(), timeZone = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export class Budget {
  /**
   * @param {object} options
   * @param {string|null} options.path      Where the ledger lives. `null` keeps it in memory (tests, dry runs).
   * @param {number} options.maxCallsPerDay Hard ceiling on model calls.
   * @param {number} options.maxUsdPerDay   Hard ceiling on estimated spend.
   */
  constructor({
    path = null,
    maxCallsPerDay = 150,
    maxUsdPerDay = 1.0,
    timeZone = "America/Sao_Paulo",
  } = {}) {
    this.path = path;
    this.maxCallsPerDay = maxCallsPerDay;
    this.maxUsdPerDay = maxUsdPerDay;
    this.timeZone = timeZone;
    this.day = this.#read();
  }

  #read() {
    const today = localDate(new Date(), this.timeZone);
    if (!this.path) {
      return emptyDay(today);
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      // A ledger from yesterday is not an error, it is the normal case every
      // morning. Rolling it over here rather than at midnight means there is no
      // scheduled job to forget to run.
      return parsed?.date === today ? parsed : emptyDay(today);
    } catch {
      // A missing or corrupt ledger opens a fresh day rather than throwing. The
      // alternative - refusing to start - turns a lost state file into an
      // outage, and the worst case of starting fresh is one extra day of budget.
      return emptyDay(today);
    }
  }

  #write() {
    if (!this.path) {
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.day)}\n`);
  }

  /** Roll the day over if the clock crossed midnight while the process ran. */
  #refresh() {
    const today = localDate(new Date(), this.timeZone);
    if (this.day.date !== today) {
      this.day = emptyDay(today);
    }
  }

  /** How many more model calls today's budget allows. Never negative. */
  remaining() {
    this.#refresh();
    const byCalls = this.maxCallsPerDay - this.day.calls;
    // A spend ceiling expressed in calls, so the caller has one number to check.
    // `Infinity` when nothing has been spent yet and there is no average to
    // divide by - the call ceiling is doing the work at that point anyway.
    const spent = this.day.usd;
    const byUsd =
      spent > 0 && this.day.calls > 0
        ? Math.floor((this.maxUsdPerDay - spent) / (spent / this.day.calls))
        : Infinity;
    return Math.max(0, Math.min(byCalls, byUsd));
  }

  exhausted() {
    return this.remaining() <= 0;
  }

  /** Record one model call and what it cost. Persisted immediately. */
  record(usd) {
    this.#refresh();
    this.day.calls += 1;
    this.day.usd = Number((this.day.usd + (usd || 0)).toFixed(6));
    this.#write();
    return this.day;
  }

  snapshot() {
    this.#refresh();
    return { ...this.day, remaining: this.remaining() };
  }
}
