import type { VoiceNoteTranscript } from "@pqp/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  requestTranscript,
  useTranscriptRequestState,
  useVoiceNoteTranscript,
} from "@/lib/voice-note-transcript";
import { markTranscriptionAvailable, useVoiceTranscription } from "@/lib/voice-transcription-prefs";

/** Past this many characters a transcript is long enough to need "show more" without measuring. */
const LONG_TRANSCRIPT_CHARS = 140;

const LINK_BUTTON =
  "rounded-sm text-xs font-medium text-text-secondary underline-offset-2 transition-colors duration-[var(--duration-fast)] hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/**
 * What goes under a voice note's card: the transcript, a quiet "transcrevendo"
 * line while one is on its way, or a small "Transcrever" button in a note that
 * has none yet.
 *
 * Nothing at all unless the message was read WITH a transcript block (the
 * server leaves it off when transcripts do not exist where the note lives) and
 * the reader has transcripts on. The button is explicit rather than automatic
 * because a transcript in a server channel is paid for by the first person who
 * asks; a conversation's notes are transcribed at send, so there the button
 * only appears when that did not happen. Your own notes never offer it.
 */
export function VoiceNoteTranscriptLine({
  attachmentId,
  base,
  isMine,
}: {
  attachmentId: string;
  base: VoiceNoteTranscript | undefined;
  isMine: boolean;
}) {
  const { t } = useTranslation();
  const { show } = useVoiceTranscription();
  const transcript = useVoiceNoteTranscript(attachmentId, base);
  const requestState = useTranscriptRequestState(attachmentId);
  const exists = base !== undefined;
  useEffect(() => {
    // A block on the read is the server saying transcription is on where this
    // note lives, which is what Settings needs to know to draw its switches.
    if (exists) {
      markTranscriptionAvailable();
    }
  }, [exists]);

  if (!show || !transcript) {
    return null;
  }

  switch (transcript.status) {
    case "done":
      return transcript.text ? (
        <TranscriptText attachmentId={attachmentId} text={transcript.text} />
      ) : null;
    case "pending":
      return (
        <p
          className="mt-1.5 text-xs text-text-tertiary motion-safe:animate-pulse"
          role="status"
          data-voice-note-transcript="pending"
        >
          {t("voiceNote.transcript.pending")}
        </p>
      );
    case "no_speech":
      return (
        <p className="mt-1.5 text-xs text-text-tertiary" data-voice-note-transcript="no_speech">
          {t("voiceNote.transcript.noSpeech")}
        </p>
      );
    case "failed":
      return (
        <p className="mt-1.5 text-xs text-text-tertiary" data-voice-note-transcript="failed">
          {t("voiceNote.transcript.failed")}
        </p>
      );
    case "unavailable":
      // No provider, or the day's budget is spent. Nothing to say and nothing
      // to press: the server lets it be asked again after a while, but a
      // button that answers the same thing every time is noise.
      return null;
    case "none":
      break;
  }

  // `none` is the only state with something to offer. `refused` means the
  // server already said no for this note: no button to press in vain.
  if (isMine || requestState === "refused") {
    return null;
  }
  return (
    <div className="mt-1.5 flex items-center gap-2" data-voice-note-transcript="none">
      <button
        type="button"
        className={LINK_BUTTON}
        onClick={() => void requestTranscript(attachmentId)}
      >
        {t("voiceNote.transcript.request")}
      </button>
      {requestState === "slow" ? (
        <span className="text-xs text-text-tertiary" role="status">
          {t("voiceNote.transcript.slow")}
        </span>
      ) : null}
      {requestState === "failed" ? (
        <span className="text-xs text-text-tertiary" role="status">
          {t("voiceNote.transcript.requestFailed")}
        </span>
      ) : null}
    </div>
  );
}

/** The text, two lines of it, and "ver mais" when there is more than that. */
function TranscriptText({ attachmentId, text }: { attachmentId: string; text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) {
      return;
    }
    const measure = () => {
      // A hidden or unmeasured element (a closed panel, a test DOM) reports no
      // height: fall back on the length, which is what two lines hold anyway.
      setOverflows(
        element.clientHeight > 0
          ? element.scrollHeight > element.clientHeight + 1
          : text.length > LONG_TRANSCRIPT_CHARS,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);

  const textId = `vn-transcript-${attachmentId}`;
  return (
    <div className="mt-1.5 max-w-[27.5rem]" data-voice-note-transcript="done">
      <p
        id={textId}
        ref={ref}
        className={cn(
          "whitespace-pre-wrap text-sm text-text-secondary [overflow-wrap:anywhere]",
          !expanded && "line-clamp-2",
        )}
      >
        {text}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={textId}
          className={cn(LINK_BUTTON, "mt-0.5")}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? t("voiceNote.transcript.less") : t("voiceNote.transcript.more")}
        </button>
      ) : null}
    </div>
  );
}
