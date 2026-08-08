import { Loader2, MessageCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  canSubmitDepoimento,
  DEPOIMENTO_MAX_LENGTH,
  depoimentoRemaining,
} from "./depoimentos-model";
import { writeDepoimento } from "./depoimentos-api";

/**
 * The compose sheet — and the single most opinionated screen in this feature.
 *
 * IT SHIPS WITH A DM FORK, right next to the send button and given the same
 * visual weight as a real option rather than a footnote. That is not a nicety;
 * it is the mitigation for the one documented failure of Orkut's depoimentos
 * (`docs/research/communities-orkut.html` §02). Because an unaccepted
 * depoimento sat in a queue only the recipient could read, indefinitely,
 * Brazilians worked out that a depoimento WAS a private message and wrote
 * confessions into it opening with "Não aceita!" — don't accept this. The
 * canonical folklore is the recipient accepting one anyway and publishing an
 * intimate message to their entire profile.
 *
 * You cannot design that away by warning people. If the private-message use has
 * no home, users make one out of your pending queue. So this sheet says, in
 * plain pt-BR, that what they are writing is going to be public on somebody's
 * profile, and offers the DM in the same breath — one tap, same text, and the
 * conversation opens with it ready to send.
 *
 * The other half of the mitigation lives on the subject's side: refusing
 * DELETES the row, so a queue full of "não aceita" confessions cannot
 * accumulate to be published later by accident.
 */

interface DepoimentoComposerProps {
  subject: { id: string; displayName: string };
  /** Written and pending — the caller closes the sheet and says so. */
  onWritten: () => void;
  /**
   * The fork. Given the typed text so the DM opens carrying it: an escape
   * hatch that makes you retype what you wrote is one nobody takes, and this
   * one has to be taken by the people who need it most.
   */
  onSendAsDm: (body: string) => void;
  onCancel: () => void;
}

export function DepoimentoComposer({
  subject,
  onWritten,
  onSendAsDm,
  onCancel,
}: DepoimentoComposerProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = depoimentoRemaining(body);
  const canSubmit = canSubmitDepoimento(body) && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await writeDepoimento(subject.id, body.trim());
      onWritten();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("depoimentos.writeFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-depoimento-composer=""
      className="mt-3 rounded-md border border-ink-4 bg-ink-3/60 p-2"
    >
      <p className="text-xs font-semibold text-paper">
        {t("depoimentos.compose.title", { name: subject.displayName })}
      </p>

      <textarea
        value={body}
        rows={4}
        autoFocus
        // One over the cap, so paste-and-trim is possible and the counter can
        // actually go red. The server is the real bound.
        maxLength={DEPOIMENTO_MAX_LENGTH + 1}
        aria-label={t("depoimentos.compose.title", {
          name: subject.displayName,
        })}
        placeholder={t("depoimentos.compose.placeholder")}
        data-depoimento-body=""
        className="mt-2 w-full resize-none rounded-md border border-ink-4 bg-ink px-2 py-1.5 text-xs text-paper placeholder:text-paper-muted"
        onChange={(event) => setBody(event.target.value)}
      />

      <div className="flex items-center justify-between">
        {/* The one sentence that has to be read, in the place a person's eye
            lands after typing. It says what happens — public, on their profile,
            once they accept — rather than asking them to be careful. */}
        <p className="text-[11px] text-paper-muted">
          {t("depoimentos.compose.publicNotice")}
        </p>
        <span
          aria-hidden="true"
          className={cn(
            "shrink-0 pl-2 text-[11px] tabular-nums",
            remaining < 0 ? "text-danger" : "text-paper-muted",
          )}
        >
          {remaining}
        </span>
      </div>

      {error && (
        <p className="mt-1.5 text-[11px] text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={!canSubmit}
          data-depoimento-send=""
          onClick={() => void submit()}
        >
          {busy && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
          {t("depoimentos.compose.send")}
        </Button>

        {/* THE FORK. `secondary`, not `ghost` — it has to look like the other
            way of doing this, because for some of the people typing here it is
            the right one. See the module note. */}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || body.trim().length === 0}
          data-depoimento-dm=""
          onClick={() => onSendAsDm(body.trim())}
        >
          <MessageCircle aria-hidden className="h-3.5 w-3.5" />
          {t("depoimentos.compose.sendAsDm")}
        </Button>

        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("depoimentos.compose.cancel")}
        </Button>
      </div>
    </div>
  );
}
