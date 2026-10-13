import { useTranslation } from "@/lib/i18n";
import type { VoiceState } from "@/hooks/use-voice";

/**
 * With nothing on stage the call is only the docked bar, and the stage's own
 * error strip is never drawn: a share that failed to start used to close the
 * picker and say nothing. Only the share error, and only while it is still
 * the current error, so another error or a cleared one hides it.
 */
export function showsDockedShareError(
  collapsed: boolean,
  voiceState: Pick<VoiceState, "error" | "screenShareError">,
): boolean {
  return (
    collapsed &&
    voiceState.screenShareError !== null &&
    voiceState.error === voiceState.screenShareError
  );
}

/** The share error in the docked call bar, in the stage strip's colours. */
export function DockedShareError({
  message,
  audioFailed,
  onShareWithoutSound,
}: {
  message: string;
  /** Sound is what took the share down: offer it again without sound. */
  audioFailed: boolean;
  onShareWithoutSound?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-voice-docked-share-error
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-danger/15 px-2.5 py-1.5 text-xs text-danger"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {audioFailed && onShareWithoutSound && (
        <button
          type="button"
          data-voice-error-share-silent
          className="shrink-0 rounded-md bg-danger/20 px-2 py-0.5 font-semibold text-danger hover:bg-danger/30"
          onClick={onShareWithoutSound}
        >
          {t("voice.control.shareWithoutSound")}
        </button>
      )}
    </div>
  );
}
