import type { JsonValue } from "@pqp/shared";
import { PqpAppError, type Participant, type StateSnapshot, type Unsubscribe } from "@pqp/app-sdk";
import {
  closePatch,
  type ResultText,
  EMPTY_STATE,
  normalizeMask,
  readState,
  startPatch,
  type Poll,
  type PollState,
  votePatch,
} from "./model";

/** The slice of `PqpApp` the poll uses. A fake of this is all a test needs. */
export interface PollHost {
  state: {
    get(): Promise<StateSnapshot>;
    patch(patch: JsonValue, options?: { baseRev?: number }): Promise<{ rev: number }>;
    on(callback: (state: StateSnapshot) => void): Unsubscribe;
  };
  participants: {
    get(): Promise<Participant[]>;
    on(callback: (participants: Participant[]) => void): Unsubscribe;
  };
  end(): Promise<null>;
}

export type Notice = "failed" | "cannot-vote" | null;
export type Connection = "online" | "reconnecting";

export interface View {
  state: PollState;
  roster: Participant[];
  selfSeat: string;
  amHost: boolean;
  amSpectator: boolean;
  /** This seat's choice, including one still being written. */
  myMask: number;
  connection: Connection;
  ended: boolean;
  notice: Notice;
}

export interface ControllerOptions {
  /** The closing line for the quiet card, in the host's language (`resultTextFor`). */
  resultText?: ResultText;
  /** Resolves after `ms`. Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const RATE_LIMIT_RETRIES = 6;
const STALE_RETRIES = 4;

/**
 * The poll's logic with no DOM in it: it keeps the state, the roster and this
 * seat's pending vote, writes votes and the host's two moves (start, close),
 * and tells the screen what to draw through `onChange`.
 */
export class PollController {
  private state: PollState = EMPTY_STATE;
  private rev = 0;
  private roster: Participant[] = [];
  private connection: Connection = "online";
  private ended = false;
  private notice: Notice = null;

  /** What this seat chose last, written or being written. `undefined`: nothing pending, the state is the truth. */
  private pending: number | undefined;
  private lastAckRev = 0;
  private writing = false;
  private flushing: Promise<void> | null = null;
  private unsubscribers: Unsubscribe[] = [];

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly resultText: ResultText | undefined;

  constructor(
    private readonly app: PollHost,
    private readonly selfSeat: string,
    private readonly onChange: (view: View) => void,
    options: ControllerOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.resultText = options.resultText;
  }

  /** Listeners first, then the values from before the listeners existed. */
  async init(initial: { connection: Connection }): Promise<void> {
    this.connection = initial.connection;
    this.unsubscribers.push(
      this.app.participants.on((next) => {
        this.roster = next;
        this.emit();
      }),
      this.app.state.on((snapshot) => this.apply(snapshot)),
    );
    this.roster = await this.app.participants.get();
    this.apply(await this.app.state.get());
  }

  dispose(): void {
    for (const off of this.unsubscribers.splice(0)) off();
  }

  setConnection(connection: Connection): void {
    this.connection = connection;
    this.emit();
  }

  setEnded(): void {
    this.ended = true;
    this.pending = undefined;
    this.emit();
  }

  clearNotice(): void {
    if (this.notice === null) return;
    this.notice = null;
    this.emit();
  }

  get view(): View {
    const me = this.roster.find((p) => p.seatId === this.selfSeat);
    const poll = this.state.poll;
    const stored = this.state.votes[this.selfSeat] ?? 0;
    const mine = this.pending ?? (poll ? normalizeMask(stored, poll) : 0);
    // the state the screen draws has this seat's own pending vote in it, so a click shows at once
    const votes =
      this.pending === undefined ? this.state.votes : { ...this.state.votes, [this.selfSeat]: this.pending };
    return {
      state: { ...this.state, votes },
      roster: this.roster,
      selfSeat: this.selfSeat,
      amHost: me?.isHost ?? false,
      amSpectator: me?.role === "spectator",
      myMask: mine,
      connection: this.connection,
      ended: this.ended,
      notice: this.notice,
    };
  }

  private emit(): void {
    this.onChange(this.view);
  }

  private apply(snapshot: StateSnapshot): void {
    if (snapshot.rev < this.rev) return;
    this.rev = snapshot.rev;
    this.state = readState(snapshot.value);
    // once what we wrote has come back in the state, the state is the truth again
    if (!this.writing && this.pending !== undefined && snapshot.rev >= this.lastAckRev) this.pending = undefined;
    this.emit();
  }

  private closed(): boolean {
    return this.state.closed !== null;
  }

  private async backoff(attempt: number): Promise<void> {
    await this.sleep(250 * (attempt + 1) + Math.floor(this.random() * 250));
  }

  /** Sets this seat's choice. `0` takes the vote back. Votes on a closed or ended poll are ignored. */
  vote(mask: number): void {
    if (this.ended || this.closed() || !this.state.poll) return;
    this.notice = null;
    this.pending = normalizeMask(mask, this.state.poll);
    this.emit();
    void this.flush();
  }

  /** One writer at a time, always sending the latest choice, so a fast double click never reorders. */
  private flush(): Promise<void> {
    if (!this.flushing) {
      this.writing = true;
      this.flushing = this.drain().finally(() => {
        this.writing = false;
        this.flushing = null;
        // everything is written: wait for the state to confirm, or show it as is if it already has
        if (this.pending !== undefined && this.lastAckRev <= this.rev) this.pending = undefined;
        this.emit();
      });
    }
    return this.flushing;
  }

  private async drain(): Promise<void> {
    let sent: number | undefined;
    while (this.pending !== undefined && this.pending !== sent && !this.ended && !this.closed()) {
      const mask = this.pending;
      const wrote = await this.writeVote(mask);
      if (wrote === "ok") {
        sent = mask;
      } else {
        // the write did not happen: show what the state says, and say so
        this.pending = undefined;
        this.notice = wrote === "refused" ? "cannot-vote" : wrote === "failed" ? "failed" : null;
        break;
      }
    }
  }

  private async writeVote(mask: number): Promise<"ok" | "refused" | "failed" | "gone"> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { rev } = await this.app.state.patch(votePatch(this.selfSeat, mask));
        this.lastAckRev = Math.max(this.lastAckRev, rev);
        return "ok";
      } catch (error) {
        if (error instanceof PqpAppError) {
          if (error.code === "ended") return "gone";
          if (error.code === "not-allowed") return "refused";
          if (error.code === "rate-limited" && attempt < RATE_LIMIT_RETRIES) {
            await this.backoff(attempt);
            continue;
          }
        }
        return "failed";
      }
    }
  }

  /** Host: starts the poll. Resolves to whether this call started it (false: a poll was already there, or it failed). */
  async start(poll: Poll): Promise<boolean> {
    if (this.ended) return false;
    this.notice = null;
    for (let attempt = 0, stale = 0; ; attempt += 1) {
      if (this.state.poll) return false;
      try {
        const { rev } = await this.app.state.patch(startPatch(poll), { baseRev: this.rev });
        this.rev = Math.max(this.rev, rev);
        this.apply(await this.app.state.get());
        return true;
      } catch (error) {
        if (error instanceof PqpAppError) {
          if (error.code === "stale-rev" && stale < STALE_RETRIES) {
            stale += 1;
            this.apply(await this.app.state.get());
            continue;
          }
          if (error.code === "rate-limited" && attempt < RATE_LIMIT_RETRIES) {
            await this.backoff(attempt);
            continue;
          }
          if (error.code === "ended") return false;
        }
        this.notice = "failed";
        this.emit();
        return false;
      }
    }
  }

  /**
   * Host: closes the vote. The patch is written against the revision the
   * counts were read from, so the frozen counts are exactly the votes the
   * state held, and a vote that lands in between makes the write stale and
   * is counted on the next try.
   */
  async close(): Promise<boolean> {
    const poll = this.state.poll;
    if (!poll || this.closed() || this.ended) return false;
    this.notice = null;
    // this seat's own last click has to be in the counts the vote is closed on
    await this.flushing;
    for (let attempt = 0, stale = 0; ; attempt += 1) {
      const current = this.state.poll;
      if (!current || this.closed()) return false;
      try {
        // the stored votes, not the ones with this seat's pending write laid over them
        const { rev } = await this.app.state.patch(closePatch(current, this.state.votes, this.resultText), { baseRev: this.rev });
        this.rev = Math.max(this.rev, rev);
        this.apply(await this.app.state.get());
        return true;
      } catch (error) {
        if (error instanceof PqpAppError) {
          if (error.code === "stale-rev" && stale < STALE_RETRIES) {
            stale += 1;
            this.apply(await this.app.state.get());
            continue;
          }
          if (error.code === "rate-limited" && attempt < RATE_LIMIT_RETRIES) {
            await this.backoff(attempt);
            continue;
          }
          if (error.code === "ended") return false;
        }
        this.notice = "failed";
        this.emit();
        return false;
      }
    }
  }

  /** Host: ends the session. The platform answers with `session.ended`, which `setEnded` handles. */
  async end(): Promise<void> {
    try {
      await this.app.end();
    } catch (error) {
      if (error instanceof PqpAppError && error.code === "ended") return;
      this.notice = "failed";
      this.emit();
    }
  }
}
