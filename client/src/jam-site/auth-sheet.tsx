import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { jt } from "@/lib/i18n/jam-site";
import {
  jamIntentHref,
  stashJamIntent,
  type JamInstrumentName,
  type JamIntent,
} from "@/lib/jam-intent";
import { jamAttribution } from "./attribution";
import { mainOrigin } from "./router";
import { button, Sheet } from "./ui";

/**
 * Everything on the public site that needs an account (liking, reporting,
 * recording, starting a jam) opens this one sheet. It says why in a sentence,
 * and its one real button continues to the app with the intention carried
 * through sign-up (`lib/jam-intent.ts`): the URL is the carrier across origins
 * (jam.pqp.gg to pqp.gg), and the same intent is stashed here too for the
 * same-origin mounts. Listening and watching never get here.
 *
 * Two more things ride on that one link. The `ref` / `utm_*` the site was
 * opened with (`ref=jam` when there were none), so the account is attributed
 * (`attribution.ts`); and, on the two sheets that lead to publishing, one plain
 * line of copyright norm with a link to the Terms.
 */

export type AskKind = "record" | "like" | "report" | "reportPart" | "copyright" | "copyrightPart" | "start";

/** The sheets that lead to putting something of yours on a public page. */
const RIGHTS_NOTE: readonly AskKind[] = ["record", "start"];

export interface Ask {
  kind: AskKind;
  songId?: string;
  instrument?: JamInstrumentName | null;
  /** The part a "report this part" is about. */
  trackId?: string;
}

interface AskContext {
  ask: (request: Ask) => void;
}

const Context = createContext<AskContext>({ ask: () => undefined });

export const useAsk = () => useContext(Context).ask;

function intentFor(request: Ask): JamIntent {
  if (request.kind === "start" || !request.songId) {
    return { kind: "new" };
  }
  return {
    kind: "song",
    songId: request.songId,
    record: request.kind === "record",
    instrument: request.kind === "record" ? (request.instrument ?? null) : null,
    act:
      request.kind === "like"
        ? "like"
        : request.kind === "report" ||
            request.kind === "reportPart" ||
            request.kind === "copyright" ||
            request.kind === "copyrightPart"
          ? "report"
          : null,
    trackId: request.kind === "reportPart" || request.kind === "copyrightPart" ? (request.trackId ?? null) : null,
    reason: request.kind === "copyright" || request.kind === "copyrightPart" ? "copyright" : null,
  };
}

export function AskProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Ask | null>(null);
  const [open, setOpen] = useState(false);
  const ask = useCallback((next: Ask) => {
    setRequest(next);
    setOpen(true);
  }, []);
  const value = useMemo(() => ({ ask }), [ask]);
  const close = useCallback(() => setOpen(false), []);

  const go = () => {
    if (!request) return;
    const intent = intentFor(request);
    try {
      stashJamIntent(window.localStorage, intent);
    } catch {
      // The URL carries it anyway.
    }
    window.location.assign(jamIntentHref(intent, mainOrigin(), jamAttribution()));
  };

  return (
    <Context.Provider value={value}>
      {children}
      <Sheet open={open} onClose={close} title={request ? jt(`ask.${request.kind}.title` as Parameters<typeof jt>[0]) : ""}>
        {request && (
          <div className="pr-8">
            <h2 className="text-xl font-extrabold leading-tight">
              {jt(`ask.${request.kind}.title` as Parameters<typeof jt>[0])}
            </h2>
            <p className="mt-2 text-[15px] leading-6 text-text-secondary">
              {jt(`ask.${request.kind}.body` as Parameters<typeof jt>[0])}
            </p>
            {RIGHTS_NOTE.includes(request.kind) && (
              <p className="mt-3 text-sm leading-5 text-text" data-jam-rights="">
                {jt("ask.rights")}{" "}
                <a
                  href={`${mainOrigin()}/terms`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold underline underline-offset-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {jt("ask.rights.link")}
                </a>
              </p>
            )}
            <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
              <button type="button" onClick={go} data-jam-ask-go="" className={button("primary", "lg", "w-full sm:w-auto")}>
                {jt(`ask.${request.kind}.cta` as Parameters<typeof jt>[0])}
              </button>
              <button type="button" onClick={close} className={button("ghost", "lg", "w-full sm:w-auto")}>
                {jt("ask.later")}
              </button>
            </div>
            <p className="mt-4 text-xs leading-5 text-text-tertiary">{jt("ask.note")}</p>
          </div>
        )}
      </Sheet>
    </Context.Provider>
  );
}
