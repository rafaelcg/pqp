import Foundation

/**
 What the local microphone track is allowed to send, as one rule.

 The mesh client creates a NEW `RTCAudioTrack` every time `startAudio` runs:
 on join, and again after a socket reconnect (`VoiceModel.apply(.ready)`). A
 new track is enabled by default, so the mute and deafen the person chose
 before the drop have to be written onto it before the first peer connection
 can send a packet. The client therefore remembers the choice itself rather
 than relying on the model to call `setMuted` again, and applies it at the
 moment the track is created. Deafened wins over unmuted, matching the web
 client and `VoiceModel.isDeafened` ("being heard while hearing nothing is a
 trap").

 Pure, so the unit-test target (which cannot open a microphone) pins it.
 */
struct LocalMicrophoneState: Equatable, Sendable {
    var muted = false
    var deafened = false

    /// The value for `RTCAudioTrack.isEnabled`.
    var trackEnabled: Bool { !muted && !deafened }
}
