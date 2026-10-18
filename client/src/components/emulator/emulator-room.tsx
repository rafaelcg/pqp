import { FileUp, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { useEmulatorEnabledFor } from "@/lib/emulator/use-emulator-enabled";
import {
  EMULATOR_ACCEPT,
  EMULATOR_MAX_BYTES,
  systemForFileName,
} from "@/lib/emulator/systems";
import { useTranslation } from "@/lib/i18n";
import type { Locale } from "@/lib/locale";

/**
 * THE EMULATOR ROOM: single player, local, behind the `emulator_room` flag.
 * Read `docs/EMULATOR_ROOM.md` before changing anything here; the rules are:
 *
 *  - pqp provides no game. There is no list, no link, no search, no download.
 *  - The game file is picked from the player's own disk with a file input and
 *    handed to the emulator in this browser, through a same-origin postMessage
 *    to a frame whose policy allows no other network (`public/emulator/
 *    frame.html`). It is never uploaded, never sent to a pqp endpoint, never
 *    stored, and its name is never read into a log, an event or a request.
 *  - Nothing is shared. No room state, no netplay, no relay. One person, one
 *    window.
 *
 * `client/src/components/emulator/emulator-room.test.tsx` pins the first two.
 */

const FRAME_SRC = "/emulator/frame.html";

/** What the page tells the emulator's language to be; the rest stay English. */
const FRAME_LANGUAGE: Record<Locale, string> = {
  en: "en-US",
  "pt-BR": "pt-BR",
  es: "es-ES",
};

type Problem = "unsupported" | "too-big" | "load";

interface EmulatorRoomProps {
  /** The server the room was opened from (the flag is per server). */
  serverId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * The room, drawn only while the flag is on for the server AND somebody opened
 * it. Flag off, or closed: nothing at all (no frame, no emulator file asked
 * for).
 */
export function EmulatorRoom({ serverId, open, onClose }: EmulatorRoomProps) {
  const enabled = useEmulatorEnabledFor(serverId);
  if (!enabled || !open) {
    return null;
  }
  return <EmulatorRoomDialog onClose={onClose} />;
}

function EmulatorRoomDialog({ onClose }: { onClose: () => void }) {
  const { t, locale } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The picked file lives here and nowhere else: memory, until the frame has
  // taken it or this dialog closes.
  const fileRef = useRef<File | null>(null);
  const [playing, setPlaying] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame || event.origin !== window.location.origin) {
        return;
      }
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === "pqp-emulator-ready" && fileRef.current) {
        frame.postMessage(
          {
            type: "pqp-emulator-load",
            file: fileRef.current,
            language: FRAME_LANGUAGE[locale],
          },
          window.location.origin,
        );
        // The frame has its own copy of the reference now.
        fileRef.current = null;
      } else if (type === "pqp-emulator-error") {
        fileRef.current = null;
        setPlaying(false);
        setProblem("load");
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      fileRef.current = null;
    };
  }, [locale]);

  const pick = useCallback((file: File | undefined) => {
    if (!file) {
      return;
    }
    if (systemForFileName(file.name) === null) {
      setProblem("unsupported");
      return;
    }
    if (file.size > EMULATOR_MAX_BYTES) {
      setProblem("too-big");
      return;
    }
    setProblem(null);
    fileRef.current = file;
    setFrameKey((key) => key + 1);
    setPlaying(true);
  }, []);

  const problemText =
    problem === "unsupported"
      ? t("emulator.problem.unsupported")
      : problem === "too-big"
        ? t("emulator.problem.tooBig")
        : problem === "load"
          ? t("emulator.problem.load")
          : null;

  return (
    <Dialog
      open
      title={t("emulator.title")}
      size="xl"
      onClose={onClose}
      footer={
        <>
          {playing && (
            <Button variant="secondary" onClick={() => inputRef.current?.click()}>
              {t("emulator.chooseAnother")}
            </Button>
          )}
          <Button variant={playing ? "default" : "secondary"} onClick={onClose}>
            {t("emulator.close")}
          </Button>
        </>
      }
    >
      <DialogBody className="space-y-4">
        <input
          ref={inputRef}
          type="file"
          accept={EMULATOR_ACCEPT}
          className="hidden"
          data-testid="emulator-file-input"
          onChange={(event) => {
            pick(event.target.files?.[0]);
            // So picking the same file again still fires a change.
            event.target.value = "";
          }}
        />

        {playing ? (
          <iframe
            key={frameKey}
            ref={frameRef}
            src={FRAME_SRC}
            title={t("emulator.frameTitle")}
            allow="autoplay; fullscreen; gamepad"
            referrerPolicy="no-referrer"
            className="aspect-[4/3] max-h-[60vh] w-full rounded-lg border border-border bg-black"
          />
        ) : (
          <div className="space-y-3 text-sm text-text-secondary">
            <p className="text-text">{t("emulator.intro")}</p>
            <p className="flex items-start gap-2">
              <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
              <span>{t("emulator.privacy")}</span>
            </p>
            <p>{t("emulator.rights")}</p>
            <p>{t("emulator.systems")}</p>
            <p>{t("emulator.solo")}</p>
            <Button onClick={() => inputRef.current?.click()}>
              <FileUp aria-hidden className="h-4 w-4" />
              {t("emulator.choose")}
            </Button>
          </div>
        )}

        {problemText && (
          <p role="alert" className="text-sm text-danger">
            {problemText}
          </p>
        )}
      </DialogBody>
    </Dialog>
  );
}
