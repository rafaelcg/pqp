import Foundation

/**
 What a voice join does about this phone's microphone.

 Every join used to be the same join: ask for the record permission before
 anything else, publish a microphone track the moment the room was up, and
 fail the whole join on a refusal. Right for a call, wrong for a watch party,
 which is a broadcast (`docs/WATCH_PARTY.md`, "Nobody watching is ever asked
 for a microphone" and "A watch party has no voice by default"). The host of
 a party with voice off takes a seat only because presenting needs one, and
 nothing about presenting a screen needs a microphone.

 The web client's version of `.none` is `VoiceAudioOptions.audienceOnly`
 (`client/src/hooks/use-voice.ts`): no `getUserMedia`, no device, no notice,
 muted as the truthful state, and speaking as a deliberate second act.
 */
enum SeatMicrophone: Equatable, Sendable {
    /// An ordinary voice channel: ask up front, publish, start muted only if
    /// the "mute when joining" setting says so. A refused permission fails
    /// the join, as it always has.
    case standard
    /// Ask and publish, but start muted whatever the setting says, and never
    /// fail the join over the microphone. What the web's go-live does for the
    /// host (`handleJoinVoice(party.channelId, { startMuted: true })` in
    /// `client/src/App.tsx`), used here only for a party with voice on.
    case startMuted
    /// No permission prompt, no capture, nothing published, muted. Unmute is
    /// the deliberate second act, and the only place the prompt is asked.
    case none
}

/**
 The microphone a watch party's host takes when going live (or coming back to
 a live party) from the stage.

 Voice on: a muted microphone, as the web host gets. Voice off, which is the
 default: none at all.

 THAT IS NARROWER THAN THE WEB, ON PURPOSE. The web's `handleWatchPartyGoLive`
 seats its host through `handleJoinVoice(..., { startMuted: true })` with no
 `audienceOnly`, whatever the party's voice option, so `use-voice.ts` opens a
 microphone (`getUserMedia`, the permission prompt) and `livekit-session.ts`
 publishes it muted. The owner's rule for a watch party is that nobody is
 asked for a device unless they deliberately speak, and a party with voice
 off has nobody to speak to. The host can still talk over the film: the
 go-live "Turn on your mic?" prompt and the unmute control both publish one,
 which is the deliberate second act the web calls `takeTheMicrophone`.
 */
func watchPartyHostSeatMicrophone(voiceEnabled: Bool) -> SeatMicrophone {
    voiceEnabled ? .startMuted : .none
}

/// Whether a join with this microphone asks for the record permission before
/// it joins. Only a seat that will publish asks; `.none` asks nobody.
func seatAsksForMicrophone(_ seat: SeatMicrophone) -> Bool {
    seat != .none
}

/// What a join does once the permission question it asked has an answer.
enum SeatMicrophonePermission: Equatable, Sendable {
    /// Carry on, with this microphone.
    case proceed(SeatMicrophone)
    /// Fail the join: an ordinary voice channel with no microphone is a join
    /// the person did not ask for.
    case refuseJoin
}

/**
 A refused permission ends an ordinary join and never a broadcast. A host who
 said no to the microphone still goes live, with no microphone (`.none`), and
 is told why the unmute control will ask again.
 */
func seatMicrophoneAfterPermission(_ seat: SeatMicrophone, granted: Bool) -> SeatMicrophonePermission {
    if granted { return .proceed(seat) }
    switch seat {
    case .standard:
        return .refuseJoin
    case .startMuted, .none:
        return .proceed(.none)
    }
}

/// Whether the seat is muted from its first packet.
func seatStartsMuted(_ seat: SeatMicrophone, muteOnJoinPreference: Bool) -> Bool {
    switch seat {
    case .standard: muteOnJoinPreference
    case .startMuted, .none: true
    }
}

/**
 Whether the SFU join publishes a microphone track once the room is up.

 `canSpeak` is the server's rule for this seat (`welcome.canSpeak`); a seat
 without it publishes nothing whatever it asked for. A `.none` seat publishes
 nothing either: its first microphone is the unmute that asks for it
 (`LiveKitVoiceClient.setMuted(false)` publishes when the room has none).
 */
func sfuJoinPublishesMicrophone(seat: SeatMicrophone, canSpeak: Bool) -> Bool {
    canSpeak && seat != .none
}
