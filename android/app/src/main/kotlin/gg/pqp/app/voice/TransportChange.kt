package gg.pqp.app.voice

import gg.pqp.app.core.VoiceParticipant

/**
 * THE ROOM MOVED UNDER US, AND WHAT THIS DEVICE DOES ABOUT IT.
 *
 * A room keeps the transport it opened on for its whole life, with exactly one
 * exception: the server may move a mesh room onto the voice server so that a
 * fourth camera, a third screen, a ninth person, or simply a fourth seat, fits.
 * The frame that announces it is `voice-transport-changed`
 * (`voiceTransportChangedMessageSchema` in `@pqp/shared`), and it carries the
 * room as the server holds it at that instant, so the receiver can build its
 * SFU session without waiting for a roster.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT A `when` INSIDE THE CONTROLLER.
 * Following the move is the whole promise behind
 * `SOCKET_CAPS.voiceTransportChanged`, and declaring that capability and then
 * not keeping it is **worse than not declaring it**: the server stops
 * releasing the seat, so the person stays listed in everybody's roster, in a
 * room whose media they cannot reach. That is a silent broken call instead of
 * a visible drop. So every branch that decides whether to move lives here,
 * free of Android imports, where a JVM test can hold it to the rule.
 *
 * Mirrors the `voice-transport-changed` case in `client/src/hooks/use-voice.ts`.
 */

/**
 * The sentence for a room that just moved onto the voice server.
 *
 * Five triggers on the wire, three sentences, and an unknown reason from a
 * newer server reads as [Room] because that one is true of every promotion.
 * The strings are the Android copies of `voice.notice.promotedFor*` in
 * `client/src/locales`.
 */
enum class PromotionNotice { Cameras, Screens, Room }

/** What the controller does, once [transportChangePlan] says to do anything. */
data class TransportChangePlan(
    /** The transport the room runs on from now on. Only ever LiveKit today. */
    val transport: VoiceTransportKind,
    /**
     * The seat we keep. This is deliberately NOT a rejoin: the peer id, the
     * mute and the roster entry are still ours and the server still holds
     * them, so only the media path changes. A rejoin would mint a new id and
     * cost the room a leave and a join cue each.
     */
    val peerId: String,
    /**
     * The room at the moment of the promotion, self included, or the roster
     * this device already held when the frame carried none.
     *
     * Falling back rather than taking the frame verbatim, because wiping the
     * participant list would blank the call bar for as long as it takes the
     * next full roster to arrive, and the frame having no `participants` at
     * all is a shape only a broken or truncated frame has.
     */
    val participants: List<VoiceParticipant>,
    /**
     * Stop the outgoing screen capture before the transport swaps.
     *
     * This client publishes a screen on mesh only (`VoiceState.screenShareSupported`),
     * so a share cannot survive the move. Stopping it is not a nicety: the
     * mesh engine that owns the capture is about to be disposed, and a
     * projection left running behind a disposed capturer is a recording
     * nobody can see and nobody asked for.
     */
    val stopScreenShare: Boolean,
    val notice: PromotionNotice,
)

internal fun promotionNoticeFor(reason: String?): PromotionNotice = when (reason) {
    "cameras" -> PromotionNotice.Cameras
    "screens" -> PromotionNotice.Screens
    // `room-full`, `room-size`, `stale-pin`, and whatever a newer server
    // invents. All of them are "the room grew", which is what the sentence says.
    else -> PromotionNotice.Room
}

/**
 * Whether to follow this promotion, and with what.
 *
 * Null means **stay exactly where we are**, and every null below is a case
 * where moving would be a guess. Guessing is what the one-transport rule
 * exists to prevent: a client that built the wrong half is a name on the
 * roster who can neither hear nor be heard, and nothing on any screen tells
 * that apart from somebody sitting there muted.
 *
 * @param heldParticipants the roster this device already has. Used only when
 *   the frame carries none.
 */
internal fun transportChangePlan(
    frameChannelId: String?,
    frameTransport: String?,
    reason: String?,
    frameParticipants: List<VoiceParticipant>,
    heldParticipants: List<VoiceParticipant>,
    inChannelId: String?,
    active: Boolean,
    currentTransport: VoiceTransportKind,
    localPeerId: String?,
    sharingScreen: Boolean,
): TransportChangePlan? {
    // Some other room. A stale or forged frame about a channel we are not in
    // must never touch a live call.
    if (frameChannelId == null || frameChannelId != inChannelId) return null
    if (!active) return null

    val kind = voiceTransportKindFor(frameTransport) ?: return null
    // ONE WAY, AND ONLY ONTO A TRANSPORT THIS BUILD RUNS. Nothing demotes a
    // live room, so a frame naming mesh is either a server this build does not
    // understand or a replay, and the safe reading of both is to ignore it.
    if (kind != VoiceTransportKind.LiveKit) return null
    // Already there. Two people turning a camera on in the same second, or a
    // cluster bus replay, must not tear a live SFU session down and build it
    // again.
    if (kind == currentTransport) return null
    // No seat, no move. Without a peer id there is nothing to mint a token
    // for, and minting one for a fresh id would be the rejoin this is not.
    val peerId = localPeerId ?: return null

    return TransportChangePlan(
        transport = kind,
        peerId = peerId,
        participants = frameParticipants.ifEmpty { heldParticipants },
        stopScreenShare = sharingScreen,
        notice = promotionNoticeFor(reason),
    )
}
