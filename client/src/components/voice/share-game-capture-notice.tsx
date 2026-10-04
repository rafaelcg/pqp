import { useEffect, useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  isShareGameCaptureHintSilenced,
  shouldShowShareCaptureNotice,
  silenceShareGameCaptureHint,
  type ShareCaptureHint,
  type ShareCaptureHintKind,
} from "@/lib/share-game-capture-hint";

/** Which title the card leads with: what the viewers get, per kind. */
const TITLE_KEYS: Record<ShareCaptureHintKind, MessageKey> = {
  black: "voice.shareGameCapture.titleBlack",
  stalled: "voice.shareGameCapture.titleStalled",
  ended: "voice.shareGameCapture.titleEnded",
};

/**
 * "Sua tela está chegando preta." One card, in the call, for the presenter
 * whose share died because a game holds the display in exclusive fullscreen
 * (`share_game_capture_hint`, Windows desktop app). The same `CornerCard` frame
 * as `MicFallbackNotice`, inline above the call controls: never over the
 * picture, which is the thing it is about.
 *
 * It says what the viewers get, the cause, and the two or three clicks that fix
 * it in CS2 and in any other game. It does not suggest sharing the game's
 * window instead of the screen: on Windows a window source is Windows Graphics
 * Capture, which fails the same way (docs/DESKTOP.md §"Sharing a game:
 * Fullscreen vs Fullscreen Windowed").
 *
 * The controller raises and clears `hint` (`use-voice.ts`); this only shows it
 * and remembers two things: "Entendi" closes THIS hint, "Não mostrar de novo"
 * silences every future one through the hint store.
 */
export function ShareGameCaptureNotice({
  hint,
  visible = true,
}: {
  hint: ShareCaptureHint | null;
  /** False while the call chrome is hidden, like the other cards in the bar. */
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [silenced, setSilenced] = useState(() => isShareGameCaptureHintSilenced());
  // Held past `hint` going null so the exit animation keeps its sentence.
  const [shown, setShown] = useState(hint);
  useEffect(() => {
    if (hint) {
      setShown(hint);
    }
  }, [hint]);

  if (!shown) {
    return null;
  }
  const open = visible && shouldShowShareCaptureNotice({ hint, closedAt, silenced });
  const title = t(TITLE_KEYS[shown.kind]);

  return (
    <CornerCard
      layout="inline"
      open={open}
      onClose={() => setClosedAt(shown.at)}
      label={title}
      dismissLabel={t("featureHint.dismiss")}
      dataAttribute="share-game-capture"
      title={title}
      body={
        <>
          <span className="block">{t("voice.shareGameCapture.body")}</span>
          <span className="mt-1 block">{t("voice.shareGameCapture.retry")}</span>
        </>
      }
      footer={
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="cta-lift rounded-full px-4"
            onClick={() => setClosedAt(shown.at)}
          >
            {t("featureHint.gotIt")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full px-4"
            data-share-game-capture-silence
            onClick={() => {
              silenceShareGameCaptureHint();
              setSilenced(true);
            }}
          >
            {t("voice.shareGameCapture.dontShowAgain")}
          </Button>
        </div>
      }
    />
  );
}
