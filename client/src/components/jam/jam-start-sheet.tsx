import { JAM_ARTIST_MAX, JAM_TITLE_MAX, type JamInstrument, type JamJoinMode } from "@pqp/shared";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import type { NewSongDraft } from "@/hooks/use-jam-studio";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK, JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";

/**
 * Starting a song: one small sheet, then the studio. The title is the only
 * thing asked for; an empty artist means it is yours (an original); "who may
 * join" defaults to anybody, which is the point of a jam.
 */

export interface JamStartResult {
  draft: NewSongDraft;
  /** What the author records first. */
  instrument: JamInstrument;
}

function newNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function JamStartSheet({
  open,
  onClose,
  onStart,
}: {
  open: boolean;
  onClose: () => void;
  onStart: (result: JamStartResult) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [joinMode, setJoinMode] = useState<JamJoinMode>("open");
  const [wanted, setWanted] = useState<JamInstrument[]>([]);
  const [touched, setTouched] = useState(false);

  const cleanTitle = title.replace(/\s+/g, " ").trim();
  const titleMissing = cleanTitle.length === 0;
  const wantedMissing = joinMode === "wanted" && wanted.length === 0;
  const invalid = titleMissing || wantedMissing;

  function submit() {
    setTouched(true);
    if (invalid) {
      return;
    }
    const cleanArtist = artist.replace(/\s+/g, " ").trim();
    // The author's own instrument: the first one they are not asking others
    // for, so a song looking for a voice starts as the guitar it has.
    const mine = JAM_INSTRUMENT_ORDER.find((one) => !wanted.includes(one)) ?? "guitar";
    onStart({
      draft: {
        title: cleanTitle,
        artist: cleanArtist === "" ? null : cleanArtist,
        joinMode,
        wantedInstruments: joinMode === "wanted" ? wanted : [],
        // One per draft: a retried create of THIS song lands on one song, and a
        // song started later from the same sheet is a different one.
        nonce: newNonce(),
      },
      instrument: joinMode === "wanted" ? mine : "guitar",
    });
  }

  return (
    <Dialog
      open={open}
      title={t("jam.start.title")}
      size="sm"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("jam.start.cancel")}
          </Button>
          <Button type="submit" form={formId} data-jam-start-go="" className="gap-2">
            {t("jam.start.go")}
          </Button>
        </div>
      }
    >
      <DialogBody>
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1.5 text-xs font-semibold text-text-secondary">
          {t("jam.start.songTitle")}
          <Input
            autoFocus
            value={title}
            maxLength={JAM_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("jam.start.songTitlePlaceholder")}
            aria-invalid={touched && titleMissing ? true : undefined}
            aria-describedby={touched && titleMissing ? `${formId}-title-error` : undefined}
            className={cn(touched && titleMissing && "border-danger")}
            data-jam-start-title=""
          />
          {touched && titleMissing && (
            <span id={`${formId}-title-error`} role="alert" className="text-xs font-normal text-danger">
              {t("jam.start.needTitle")}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1.5 text-xs font-semibold text-text-secondary">
          {t("jam.start.artist")}
          <Input
            value={artist}
            maxLength={JAM_ARTIST_MAX}
            onChange={(event) => setArtist(event.target.value)}
            placeholder={t("jam.start.artistPlaceholder")}
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold text-text-secondary">{t("jam.start.who")}</span>
          <RadioGroup<JamJoinMode>
            label={t("jam.start.who")}
            variant="list"
            value={joinMode}
            onValueChange={setJoinMode}
            options={[
              { value: "open", label: t("jam.start.open"), description: t("jam.start.openHint") },
              { value: "wanted", label: t("jam.start.wanted"), description: t("jam.start.wantedHint") },
              { value: "closed", label: t("jam.start.closed"), description: t("jam.start.closedHint") },
            ]}
          />
        </div>

        {joinMode === "wanted" && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-text-secondary">{t("jam.start.pickWanted")}</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("jam.start.pickWanted")}>
              {JAM_INSTRUMENT_ORDER.map((instrument) => {
                const look = JAM_INSTRUMENT_LOOK[instrument];
                const Icon = look.icon;
                const on = wanted.includes(instrument);
                return (
                  <button
                    key={instrument}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setWanted((before) =>
                        before.includes(instrument)
                          ? before.filter((one) => one !== instrument)
                          : [...before, instrument],
                      )
                    }
                    className={cn(
                      "flex h-11 items-center gap-2 rounded-full px-4 text-sm font-bold outline-none transition-[background,color,transform] duration-[var(--duration-fast)] focus-visible:ring-2 focus-visible:ring-focus-ring active:scale-[0.96]",
                      on ? look.fill : "bg-surface-2 text-text-secondary hover:bg-border hover:text-text",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {t(look.nameKey as MessageKey)}
                  </button>
                );
              })}
            </div>
            {touched && wantedMissing && (
              <span role="alert" className="text-xs text-danger">
                {t("jam.start.needWanted")}
              </span>
            )}
          </div>
        )}
      </form>
      </DialogBody>
    </Dialog>
  );
}
