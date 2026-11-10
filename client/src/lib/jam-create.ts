import { jamOutcomeUnknown } from "@/lib/jam-api";

/**
 * Making a Jam channel without ever making two.
 *
 * A create that gets no answer (or a server error) may still have landed. So after
 * that kind of failure the server's list is READ, and a Jam channel that is new to
 * the client is the answer. When the list cannot be read either, the baseline (the
 * channel ids known before the first attempt) is kept as `unsure`, and the NEXT
 * call settles it before it is allowed to create anything.
 */
export interface JamCreateResult<C> {
  /** The channel to open: made now, or found because an earlier attempt had landed. */
  channel: C | null;
  /** Set while an attempt is unsettled; hand it back to the next call. */
  unsure: ReadonlySet<string> | null;
  /** Why nothing was made, for the screen to say. */
  failure: "unreadable" | { error: unknown } | null;
  /** The list was read (the screen refreshes its own copy). */
  listed: boolean;
}

export async function createJamOnce<C extends { id: string; type: string }>(input: {
  known: ReadonlySet<string>;
  unsure: ReadonlySet<string> | null;
  create: () => Promise<C>;
  list: () => Promise<readonly C[]>;
}): Promise<JamCreateResult<C>> {
  const baseline = input.unsure ?? input.known;
  const findNew = async (): Promise<C | null> =>
    (await input.list()).find((one) => one.type === "jam" && !baseline.has(one.id)) ?? null;

  if (input.unsure) {
    try {
      const found = await findNew();
      if (found) {
        return { channel: found, unsure: null, failure: null, listed: true };
      }
    } catch {
      return { channel: null, unsure: input.unsure, failure: "unreadable", listed: false };
    }
    // read fine and nothing new: the earlier attempt did not land
  }
  try {
    return { channel: await input.create(), unsure: null, failure: null, listed: false };
  } catch (error) {
    if (!jamOutcomeUnknown(error)) {
      return { channel: null, unsure: null, failure: { error }, listed: false };
    }
    try {
      const found = await findNew();
      return { channel: found, unsure: null, failure: found ? null : { error }, listed: true };
    } catch {
      return { channel: null, unsure: baseline, failure: { error }, listed: false };
    }
  }
}
