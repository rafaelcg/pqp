import { useId, useState } from "react";
import { Youtube } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  parseYouTubeUrl,
  type ParsedYouTubeLink,
} from "@/lib/watch-party/state";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Paste a link, start a party.
 *
 * V1 IS PASTE ONLY AND THE FORM IS BUILT AS THOUGH THAT WERE THE PLAN. There
 * is no search box because the YouTube Data API's terms will not let a public
 * AGPL repo ship the credentials one needs, and a server-side proxy is a
 * different piece of infrastructure than the one we are building. That is a
 * fine reason, and it is also not the user's business: an apology under the
 * field ("sorry, no search yet") would advertise a missing feature to somebody
 * who arrived with a link already on their clipboard, which is how people
 * actually get to a YouTube video they want to show someone. So the field is
 * wide, focused, and the only thing on screen.
 *
 * NO PARSING HAPPENS HERE. `parseYouTubeUrl` comes from
 * `lib/watch-party/state.ts`, which is the one place that gets to decide what
 * counts as a YouTube link, which forms it accepts, and what `?t=1m30s` means.
 * This component's whole contribution is the moment the answer is shown: on
 * submit rather than on every keystroke, so half a pasted URL is never briefly
 * called wrong. It is a prop with a default rather than a bare import so a test
 * can drive the form without dragging the parser in behind it.
 */
export interface WatchPartyComposerProps {
  /** Overridden only in tests. `state.ts`'s parser is the real one. */
  parseVideoUrl?: (input: string) => ParsedYouTubeLink | null;
  /**
   * The parsed link, `startMs` included: somebody who pastes a URL with a
   * timestamp on it meant that timestamp, and dropping it would start the
   * channel at zero on a video the person had already scrubbed into.
   */
  onLoadVideo: (link: ParsedYouTubeLink) => void;
  /** Absent when this is the panel's whole content and there is nothing to go back to. */
  onCancel?: () => void;
  /** The heading is different for "start one" and for "swap the current one". */
  variant: "start" | "change";
  autoFocus?: boolean;
}

export function WatchPartyComposer({
  parseVideoUrl = parseYouTubeUrl,
  onLoadVideo,
  onCancel,
  variant,
  autoFocus = false,
}: WatchPartyComposerProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [rejected, setRejected] = useState(false);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;

  return (
    <form
      className={cn(
        "flex w-full flex-col gap-3",
        variant === "start" && "max-w-md text-center",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        const link = parseVideoUrl(value.trim());
        if (link === null) {
          setRejected(true);
          return;
        }
        setRejected(false);
        setValue("");
        onLoadVideo(link);
      }}
    >
      {variant === "start" && (
        <div className="flex flex-col items-center gap-1">
          <Youtube className="h-6 w-6 text-signal" aria-hidden="true" />
          <h2 className="text-sm font-semibold">
            {t("watchParty.compose.heading")}
          </h2>
          <p className="text-xs text-paper-muted">
            {t("watchParty.compose.body")}
          </p>
        </div>
      )}

      <div className="flex w-full items-center gap-2">
        <label className="sr-only" htmlFor={fieldId}>
          {t("watchParty.compose.label")}
        </label>
        <Input
          id={fieldId}
          // `url` rather than `text`: it is what puts the "/" and the ".com"
          // on a phone keyboard, and this field only ever holds a URL.
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          aria-invalid={rejected || undefined}
          aria-describedby={rejected ? errorId : undefined}
          placeholder={t("watchParty.compose.placeholder")}
          onChange={(event) => {
            setValue(event.target.value);
            // The complaint goes away the moment they start fixing it. A
            // message that survives the edit is nagging, not helping.
            setRejected(false);
          }}
          className="h-9 min-w-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={value.trim() === ""}>
          {t("watchParty.compose.submit")}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t("watchParty.compose.cancel")}
          </Button>
        )}
      </div>

      {rejected && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {t("watchParty.compose.invalid")}
        </p>
      )}
    </form>
  );
}
