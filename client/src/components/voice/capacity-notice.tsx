import { useEffect, useRef, useState } from "react";
import type { VoiceRoomTransport } from "@pqp/shared";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { isAutomatedBrowser } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";
import {
  capacityNoticeMessage,
  capacityRiseBetween,
  isVoiceCapacityHintSeen,
  rememberVoiceCapacityHint,
  shouldShowCapacityNotice,
} from "@/lib/voice-capacity";

/**
 * "A call cresceu." One card, in the call, when the room's limits go up under
 * the people already in it.
 *
 * Quiet on purpose: the same `CornerCard` frame as the other coachmarks, laid
 * out inline above the call controls rather than in the corner queue, because
 * it is about the call it sits on. Not a dialog, not a chat message, and never
 * a word about transports or media servers. See `docs/ONBOARDING.md`.
 *
 * WHO DOES NOT GET IT. Somebody who joins a room that was already promoted:
 * nothing changed for them, so `roseFrom` is null and there is no card. The
 * arithmetic that decides whether anything actually grew is in
 * `lib/voice-capacity.ts`, off the shared limit maps, so a room that changed
 * transport without gaining anything stays silent too.
 */
export function CapacityNotice({
  voiceChannelId,
  transport,
  roseFrom,
  visible = true,
  seen,
}: {
  voiceChannelId: string | null;
  /** The room's transport now. */
  transport: VoiceRoomTransport | null;
  /** What it was before it changed under us, or null. `VoiceState.capacityRoseFrom`. */
  roseFrom: VoiceRoomTransport | null;
  /**
   * False while the call chrome is hidden (idle auto-hide). The card is inside
   * the control bar and fades with it, and a card nobody can see must not
   * spend its one impression: that is the exact failure `docs/ONBOARDING.md`
   * warns about, a surface that records itself as shown while sitting under
   * something.
   */
  visible?: boolean;
  /**
   * Override for tests. Production reads the one hint store
   * (`lib/hints.ts`), which never persists on localhost and never shows a card
   * to Playwright.
   */
  seen?: boolean;
}) {
  const { t } = useTranslation();
  const [dismissedChannel, setDismissedChannel] = useState<string | null>(null);
  const rise = capacityRiseBetween(roseFrom, transport);

  /**
   * The decision, taken once per room the first time a rise is visible for it,
   * and cached in a ref so a later re-render cannot take it again against a
   * storage key this very card has since written. A ref used as a memo cache
   * is the sanctioned kind of render-phase write; nothing here mutates state.
   */
  const decision = useRef<{ channelId: string; show: boolean } | null>(null);
  if (rise && voiceChannelId && decision.current?.channelId !== voiceChannelId) {
    decision.current = {
      channelId: voiceChannelId,
      show: shouldShowCapacityNotice({
        rise,
        seen: seen ?? isVoiceCapacityHintSeen(voiceChannelId),
        automated: isAutomatedBrowser(),
      }),
    };
  }

  const show =
    visible &&
    rise !== null &&
    voiceChannelId !== null &&
    decision.current?.channelId === voiceChannelId &&
    decision.current.show &&
    dismissedChannel !== voiceChannelId;

  // Written on the impression, not on the dismiss: a card that was seen and
  // then scrolled past is still a card that was seen, and it must not come
  // back the next time this room grows.
  useEffect(() => {
    if (show && voiceChannelId) {
      rememberVoiceCapacityHint(voiceChannelId);
    }
  }, [show, voiceChannelId]);

  if (!rise) {
    return null;
  }

  return (
    <CornerCard
      layout="inline"
      open={show}
      onClose={() => setDismissedChannel(voiceChannelId)}
      label={t("voice.capacity.title")}
      dismissLabel={t("featureHint.dismiss")}
      dataAttribute="voice-capacity"
      title={t("voice.capacity.title")}
      body={capacityNoticeMessage(rise)}
      footer={
        <Button
          size="sm"
          className="cta-lift rounded-full px-4"
          onClick={() => setDismissedChannel(voiceChannelId)}
        >
          {t("featureHint.gotIt")}
        </Button>
      }
    />
  );
}
